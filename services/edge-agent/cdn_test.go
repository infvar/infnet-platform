package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCdnCacheSkipsPersonalizedRequestsAndResponses(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "https://cdn.example.test/data", nil)
	if !cacheableRequest(request) {
		t.Fatal("expected anonymous GET to be cacheable")
	}
	request.Header.Set("Cookie", "session=secret")
	if cacheableRequest(request) {
		t.Fatal("expected cookie-bearing request to bypass cache")
	}
	request.Header.Del("Cookie")
	request.Header.Set("Authorization", "Bearer secret")
	if cacheableRequest(request) {
		t.Fatal("expected authorized request to bypass cache")
	}

	for _, header := range []string{"private", "no-store", "no-cache"} {
		response := &http.Response{Header: http.Header{"Cache-Control": []string{header}}}
		if cacheableResponse(response) {
			t.Fatalf("expected Cache-Control: %s response to bypass cache", header)
		}
	}
	response := &http.Response{Header: http.Header{"Set-Cookie": []string{"session=secret"}}}
	if cacheableResponse(response) {
		t.Fatal("expected Set-Cookie response to bypass cache")
	}
	response = &http.Response{Header: http.Header{"Vary": []string{"Accept-Encoding"}}}
	if cacheableResponse(response) {
		t.Fatal("expected Vary response to bypass cache")
	}
}

func TestCdnRouteCachesGetResponses(t *testing.T) {
	calls := 0
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("origin-response"))
	}))
	defer origin.Close()

	manager := newCdnManager()
	manager.client = origin.Client()
	parsedOrigin := origin.URL
	manager.routes["cdn.example.test"] = cdnRoute{Hostname: "cdn.example.test", Origin: parsedOrigin, CacheSeconds: 60}
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "http://cdn.example.test/assets/app.js", nil)
		recorder := httptest.NewRecorder()
		manager.handler(recorder, req)
		if recorder.Code != http.StatusOK || recorder.Body.String() != "origin-response" {
			t.Fatalf("unexpected response: %d %q", recorder.Code, recorder.Body.String())
		}
		if i == 1 && recorder.Header().Get("X-Infnet-Cache") != "HIT" {
			t.Fatalf("expected cache hit, got %q", recorder.Header().Get("X-Infnet-Cache"))
		}
	}
	if calls != 1 {
		t.Fatalf("origin called %d times, want 1", calls)
	}
}

func TestCdnCacheIsBounded(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(r.URL.Path))
	}))
	defer origin.Close()
	manager := newCdnManager()
	manager.client = origin.Client()
	manager.maxCacheEntries = 1
	manager.routes["cdn.example.test"] = cdnRoute{Hostname: "cdn.example.test", Origin: origin.URL, CacheSeconds: 60}
	for _, path := range []string{"/one", "/two"} {
		req := httptest.NewRequest(http.MethodGet, "http://cdn.example.test"+path, nil)
		manager.handler(httptest.NewRecorder(), req)
	}
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	if len(manager.cache) != 1 {
		t.Fatalf("cache has %d entries, want 1", len(manager.cache))
	}
}

func TestSafeOriginClientRejectsPrivateResolution(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer server.Close()
	req, err := http.NewRequest(http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := safeOriginClient("127.0.0.1").Do(req); err == nil {
		t.Fatal("expected private origin to be rejected")
	}
}

func TestCdnRemoveClearsRouteAndCache(t *testing.T) {
	manager := newCdnManager()
	manager.routes["cdn.example.test"] = cdnRoute{ID: "cdn-1", Hostname: "cdn.example.test", Origin: "https://origin.example.test", CacheSeconds: 60}
	manager.cache["GET cdn.example.test/app.js"] = cdnEntry{storedAt: time.Now()}
	if err := manager.remove([]byte(`{"id":"cdn-1"}`)); err != nil {
		t.Fatal(err)
	}
	if _, ok := manager.routes["cdn.example.test"]; ok {
		t.Fatal("route was not removed")
	}
	if len(manager.cache) != 0 {
		t.Fatal("route cache was not removed")
	}
}

func TestBlockedOriginHost(t *testing.T) {
	for _, host := range []string{"localhost", "127.0.0.1", "10.0.0.5", "metadata.internal"} {
		if !blockedOriginHost(host) {
			t.Fatalf("expected %s to be blocked", host)
		}
	}
}
