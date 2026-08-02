package main

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"sync"
	"time"
)

// The tunnel protocol is intentionally small and private to infNet. A client
// session is parked at the edge until a connection arrives on its public port.
type tunnelSpec struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Ticket          string    `json:"ticket"`
	RemotePort      int       `json:"remotePort"`
	TicketExpiresAt time.Time `json:"ticketExpiresAt"`
}
type tunnelRemoval struct{ ID, Name string }

type tunnelSession struct {
	conn   net.Conn
	reader *bufio.Reader
}

type tunnelManager struct {
	mu        sync.RWMutex
	specs     map[string]tunnelSpec
	sessions  map[string]chan tunnelSession
	listeners map[string]net.Listener
	usage     *usageRegistry
}

func newTunnelManager(registries ...*usageRegistry) *tunnelManager {
	var usage *usageRegistry
	if len(registries) > 0 {
		usage = registries[0]
	}
	return &tunnelManager{specs: make(map[string]tunnelSpec), sessions: make(map[string]chan tunnelSession), listeners: make(map[string]net.Listener), usage: usage}
}

func (m *tunnelManager) apply(payload json.RawMessage) error {
	var spec tunnelSpec
	if err := json.Unmarshal(payload, &spec); err != nil {
		return err
	}
	if spec.Name == "" || spec.Ticket == "" || spec.RemotePort < 1 || spec.RemotePort > 65535 || spec.TicketExpiresAt.IsZero() || time.Now().After(spec.TicketExpiresAt) {
		return fmt.Errorf("invalid tunnel command")
	}
	m.mu.Lock()
	if existing, exists := m.specs[spec.Name]; exists {
		if existing.ID != spec.ID {
			m.mu.Unlock()
			return fmt.Errorf("tunnel name %q is already assigned to another tunnel", spec.Name)
		}
		// Ticket rotation keeps the existing public listener and client queue.
		m.specs[spec.Name] = spec
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()
	listener, err := net.Listen("tcp", ":"+strconv.Itoa(spec.RemotePort))
	if err != nil {
		return fmt.Errorf("tunnel %s listen failed: %w", spec.Name, err)
	}
	m.mu.Lock()
	if existing, exists := m.specs[spec.Name]; exists {
		m.mu.Unlock()
		_ = listener.Close()
		if existing.ID == spec.ID {
			return nil
		}
		return fmt.Errorf("tunnel name %q is already assigned to another tunnel", spec.Name)
	}
	m.specs[spec.Name] = spec
	m.sessions[spec.Name] = make(chan tunnelSession, 1)
	m.listeners[spec.Name] = listener
	m.mu.Unlock()
	go m.servePublic(spec, listener)
	log.Printf("tunnel %s listening on :%d", spec.Name, spec.RemotePort)
	return nil
}

func (m *tunnelManager) remove(payload json.RawMessage) error {
	var removal tunnelRemoval
	if err := json.Unmarshal(payload, &removal); err != nil {
		return err
	}
	m.mu.Lock()
	name := removal.Name
	if name == "" {
		for candidateName, spec := range m.specs {
			if spec.ID == removal.ID {
				name = candidateName
				break
			}
		}
	}
	if name == "" {
		m.mu.Unlock()
		return nil
	}
	listener := m.listeners[name]
	queue := m.sessions[name]
	delete(m.specs, name)
	delete(m.sessions, name)
	delete(m.listeners, name)
	m.mu.Unlock()
	if listener != nil {
		_ = listener.Close()
	}
	if queue != nil {
		select {
		case session := <-queue:
			_ = session.conn.Close()
		default:
		}
	}
	return nil
}

func (m *tunnelManager) servePublic(spec tunnelSpec, listener net.Listener) {
	defer listener.Close()
	for {
		remote, err := listener.Accept()
		if err != nil {
			log.Printf("tunnel %s accept failed: %v", spec.Name, err)
			return
		}
		go m.forward(spec, remote)
	}
}

func (m *tunnelManager) forward(spec tunnelSpec, remote net.Conn) {
	defer remote.Close()
	m.mu.RLock()
	queue := m.sessions[spec.Name]
	m.mu.RUnlock()
	if queue == nil {
		return
	}
	var session tunnelSession
	select {
	case session = <-queue:
	case <-time.After(30 * time.Second):
		return
	}
	defer session.conn.Close()
	if _, err := session.conn.Write([]byte("OPEN\n")); err != nil {
		return
	}
	if line, err := session.reader.ReadString('\n'); err != nil || line != "CONNECTED\n" {
		return
	}
	go func() {
		n, _ := io.Copy(session.conn, remote)
		if m.usage != nil {
			m.usage.add(spec.ID, "tunnel", uint64(n))
		}
	}()
	n, _ := io.Copy(remote, session.reader)
	if m.usage != nil {
		m.usage.add(spec.ID, "tunnel", uint64(n))
	}
}

func (m *tunnelManager) serveClient(conn net.Conn) {
	reader := bufio.NewReader(conn)
	var hello struct {
		Version string `json:"version"`
		Ticket  string `json:"ticket"`
		Name    string `json:"name"`
	}
	if err := json.NewDecoder(reader).Decode(&hello); err != nil {
		conn.Close()
		return
	}
	m.mu.RLock()
	spec, ok := m.specs[hello.Name]
	queue := m.sessions[hello.Name]
	m.mu.RUnlock()
	if !ok || queue == nil || spec.Ticket != hello.Ticket || time.Now().After(spec.TicketExpiresAt) {
		_, _ = conn.Write([]byte("REJECT\n"))
		conn.Close()
		return
	}
	if _, err := conn.Write([]byte("READY\n")); err != nil {
		conn.Close()
		return
	}
	select {
	case queue <- tunnelSession{conn: conn, reader: reader}:
	case old := <-queue:
		_ = old.conn.Close()
		queue <- tunnelSession{conn: conn, reader: reader}
	}
}

func serveTunnelEndpoint(addr, certFile, keyFile string, manager *tunnelManager) error {
	return serveTunnelEndpointReady(addr, certFile, keyFile, manager, nil)
}

func serveTunnelEndpointReady(addr, certFile, keyFile string, manager *tunnelManager, ready chan<- error) error {
	var listener net.Listener
	var err error
	if certFile != "" && keyFile != "" {
		cert, loadErr := tls.LoadX509KeyPair(certFile, keyFile)
		if loadErr != nil {
			if ready != nil {
				ready <- loadErr
			}
			return loadErr
		}
		listener, err = tls.Listen("tcp", addr, &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}})
	} else {
		if os.Getenv("INFNET_ALLOW_PLAINTEXT") != "true" {
			err := fmt.Errorf("TLS certificate and key are required; set INFNET_ALLOW_PLAINTEXT=true only for local development")
			if ready != nil {
				ready <- err
			}
			return err
		}
		listener, err = net.Listen("tcp", addr)
		log.Printf("WARNING: tunnel endpoint %s is plaintext; configure INFNET_TLS_CERT and INFNET_TLS_KEY for production", addr)
	}
	if err != nil {
		if ready != nil {
			ready <- err
		}
		return err
	}
	log.Printf("tunnel endpoint listening on %s", addr)
	if ready != nil {
		ready <- nil
	}
	for {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return acceptErr
		}
		go manager.serveClient(conn)
	}
}
