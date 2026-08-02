package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type cdnRoute struct {
	ID           string `json:"id"`
	Hostname     string `json:"hostname"`
	Origin       string `json:"origin"`
	CacheSeconds int    `json:"cacheSeconds"`
}
type cdnRemoval struct{ ID, Hostname string }
type cdnEntry struct {
	status   int
	header   http.Header
	body     []byte
	expires  time.Time
	storedAt time.Time
}
type cdnManager struct {
	mu              sync.RWMutex
	routes          map[string]cdnRoute
	cache           map[string]cdnEntry
	maxCacheEntries int
	client          *http.Client
	usage           *usageRegistry
}

const maxCdnBodyBytes = 10 << 20

func newCdnManager(registries ...*usageRegistry) *cdnManager {
	maxEntries, err := strconv.Atoi(os.Getenv("INFNET_CDN_MAX_CACHE_ENTRIES"))
	if err != nil || maxEntries < 1 {
		maxEntries = 1000
	}
	var usage *usageRegistry
	if len(registries) > 0 {
		usage = registries[0]
	}
	return &cdnManager{routes: make(map[string]cdnRoute), cache: make(map[string]cdnEntry), maxCacheEntries: maxEntries, usage: usage}
}
func (m *cdnManager) apply(raw []byte) error {
	var route cdnRoute
	if err := json.Unmarshal(raw, &route); err != nil {
		return err
	}
	parsed, err := url.Parse(route.Origin)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || route.Hostname == "" {
		return fmt.Errorf("invalid CDN route")
	}
	if blockedOriginHost(parsed.Hostname()) {
		return fmt.Errorf("origin resolves to a private or local address")
	}
	route.Hostname = strings.ToLower(route.Hostname)
	m.mu.Lock()
	m.routes[route.Hostname] = route
	m.mu.Unlock()
	return nil
}

func (m *cdnManager) remove(raw []byte) error {
	var removal cdnRemoval
	if err := json.Unmarshal(raw, &removal); err != nil {
		return err
	}
	m.mu.Lock()
	hostname := strings.ToLower(removal.Hostname)
	if hostname == "" {
		for candidateHost, route := range m.routes {
			if route.ID == removal.ID {
				hostname = candidateHost
				break
			}
		}
	}
	if hostname != "" {
		delete(m.routes, hostname)
		for key := range m.cache {
			if strings.Contains(key, " "+hostname+"/") || strings.HasSuffix(key, " "+hostname) {
				delete(m.cache, key)
			}
		}
	}
	m.mu.Unlock()
	return nil
}

func blockedOriginHost(host string) bool {
	lower := strings.ToLower(host)
	if lower == "localhost" || strings.HasSuffix(lower, ".local") || strings.HasSuffix(lower, ".internal") {
		return true
	}
	ips := net.ParseIP(host)
	if ips != nil {
		return blockedIP(ips)
	}
	resolved, err := net.LookupIP(host)
	if err != nil || len(resolved) == 0 {
		return true
	}
	for _, ip := range resolved {
		if blockedIP(ip) {
			return true
		}
	}
	return false
}
func (m *cdnManager) handler(w http.ResponseWriter, r *http.Request) {
	if r.ContentLength > maxCdnBodyBytes {
		http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
		return
	}
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, maxCdnBodyBytes)
	}
	host := strings.ToLower(r.Host)
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	m.mu.RLock()
	route, ok := m.routes[host]
	m.mu.RUnlock()
	if !ok {
		http.Error(w, "unknown CDN host", http.StatusNotFound)
		return
	}
	key := r.Method + " " + host + r.URL.RequestURI()
	if cacheableRequest(r) {
		m.mu.RLock()
		entry, exists := m.cache[key]
		m.mu.RUnlock()
		if exists && time.Now().Before(entry.expires) {
			copyHeader(w.Header(), entry.header)
			w.Header().Set("X-Infnet-Cache", "HIT")
			w.WriteHeader(entry.status)
			_, _ = w.Write(entry.body)
			if m.usage != nil {
				m.usage.add(route.ID, "cdn", uint64(len(entry.body)))
			}
			return
		}
	}
	target, _ := url.Parse(route.Origin)
	target.Path = strings.TrimRight(target.Path, "/") + "/" + strings.TrimLeft(r.URL.Path, "/")
	target.RawQuery = r.URL.RawQuery
	request, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), r.Body)
	if err != nil {
		http.Error(w, "bad origin", 502)
		return
	}
	request.Header = r.Header.Clone()
	request.Host = target.Host
	client := m.client
	if client == nil {
		client = safeOriginClient(target.Hostname())
	}
	response, err := client.Do(request)
	if err != nil {
		http.Error(w, "origin unavailable", 502)
		return
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxCdnBodyBytes+1))
	if err != nil {
		http.Error(w, "origin read failed", 502)
		return
	}
	if len(body) > maxCdnBodyBytes {
		http.Error(w, "origin response too large", http.StatusBadGateway)
		return
	}
	copyHeader(w.Header(), response.Header)
	w.Header().Set("X-Infnet-Cache", "MISS")
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(body)
	if m.usage != nil {
		m.usage.add(route.ID, "cdn", uint64(len(body)))
	}
	if cacheableRequest(r) && cacheableResponse(response) && response.StatusCode == http.StatusOK && route.CacheSeconds > 0 {
		m.mu.Lock()
		m.cache[key] = cdnEntry{status: response.StatusCode, header: response.Header.Clone(), body: body, expires: time.Now().Add(time.Duration(route.CacheSeconds) * time.Second), storedAt: time.Now()}
		for len(m.cache) > m.maxCacheEntries {
			oldestKey := ""
			var oldest time.Time
			for candidateKey, candidate := range m.cache {
				if candidateKey == key {
					continue
				}
				if oldestKey == "" || candidate.storedAt.Before(oldest) {
					oldestKey, oldest = candidateKey, candidate.storedAt
				}
			}
			if oldestKey == "" {
				break
			}
			delete(m.cache, oldestKey)
		}
		m.mu.Unlock()
	}
}

func cacheableRequest(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	// The cache key does not vary by credentials or arbitrary request headers.
	// Never cache personalized requests under that key.
	return r.Header.Get("Authorization") == "" && r.Header.Get("Cookie") == "" && r.Header.Get("Cache-Control") != "no-cache"
}

func cacheableResponse(response *http.Response) bool {
	if response.Header.Get("Set-Cookie") != "" || response.Header.Get("Vary") != "" {
		return false
	}
	for _, directive := range strings.Split(strings.ToLower(response.Header.Get("Cache-Control")), ",") {
		switch strings.TrimSpace(directive) {
		case "private", "no-store", "no-cache":
			return false
		}
	}
	return true
}

func safeOriginClient(host string) *http.Client {
	return &http.Client{
		Timeout: 20 * time.Second,
		// Do not follow redirects: a public origin must not redirect the edge
		// into a private address or another tenant's origin.
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			port := "443"
			if _, parsedPort, err := net.SplitHostPort(address); err == nil {
				port = parsedPort
			} else if strings.HasPrefix(network, "tcp") {
				port = "80"
			}
			ips, err := net.LookupIP(host)
			if err != nil || len(ips) == 0 {
				return nil, fmt.Errorf("origin DNS lookup failed")
			}
			var lastErr error
			for _, ip := range ips {
				if blockedIP(ip) {
					continue
				}
				conn, dialErr := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
				if dialErr == nil {
					return conn, nil
				}
				lastErr = dialErr
			}
			if lastErr != nil {
				return nil, lastErr
			}
			return nil, fmt.Errorf("origin resolved to a private or local address")
		}},
	}
}

func blockedIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast()
}
func (m *cdnManager) serve(addr, certFile, keyFile string) error {
	return m.serveReady(addr, certFile, keyFile, nil)
}

func (m *cdnManager) serveReady(addr, certFile, keyFile string, ready chan<- error) error {
	log.Printf("CDN endpoint listening on %s", addr)
	server := &http.Server{Addr: addr, Handler: http.HandlerFunc(m.handler), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	if certFile != "" && keyFile != "" {
		cert, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err != nil {
			if ready != nil {
				ready <- err
			}
			return err
		}
		listener, err := net.Listen("tcp", addr)
		if err != nil {
			if ready != nil {
				ready <- err
			}
			return err
		}
		server.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}}
		if ready != nil {
			ready <- nil
		}
		return server.Serve(tls.NewListener(listener, server.TLSConfig))
	}
	if os.Getenv("INFNET_ALLOW_PLAINTEXT") != "true" {
		err := fmt.Errorf("CDN TLS certificate and key are required; set INFNET_ALLOW_PLAINTEXT=true only for local development")
		if ready != nil {
			ready <- err
		}
		return err
	}
	log.Printf("WARNING: CDN endpoint %s is plaintext for local development", addr)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		if ready != nil {
			ready <- err
		}
		return err
	}
	if ready != nil {
		ready <- nil
	}
	return server.Serve(listener)
}
func copyHeader(dst, src http.Header) {
	for key, values := range src {
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}
