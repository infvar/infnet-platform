package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNodeEnvelopeUsesControlPlaneFieldNames(t *testing.T) {
	payload, err := json.Marshal(node{ID: "node-1", Name: "edge-1", Region: "cn", Capabilities: []string{"cdn", "frp"}})
	if err != nil {
		t.Fatal(err)
	}
	got := string(payload)
	for _, field := range []string{`"id":"node-1"`, `"name":"edge-1"`, `"region":"cn"`} {
		if !strings.Contains(got, field) {
			t.Fatalf("payload %s does not contain %s", got, field)
		}
	}
}

func TestValidateControlURLRequiresHTTPSByDefault(t *testing.T) {
	t.Setenv("INFNET_ALLOW_PLAINTEXT", "")
	if err := validateControlURL("http://control.example.com"); err == nil {
		t.Fatal("expected HTTP control URL to be rejected")
	}
	if err := validateControlURL("https://control.example.com"); err != nil {
		t.Fatalf("expected HTTPS control URL to pass: %v", err)
	}
}

func TestValidateDataPlaneTLSRequiresProductionCertificate(t *testing.T) {
	t.Setenv("INFNET_ALLOW_PLAINTEXT", "")
	if err := validateDataPlaneTLS("", ""); err == nil {
		t.Fatal("expected production TLS configuration to be required")
	}
	t.Setenv("INFNET_ALLOW_PLAINTEXT", "true")
	if err := validateDataPlaneTLS("", ""); err != nil {
		t.Fatalf("expected explicit plaintext development mode to pass: %v", err)
	}
}

func TestValidateControlURLAllowsExplicitDevelopmentHTTP(t *testing.T) {
	t.Setenv("INFNET_ALLOW_PLAINTEXT", "true")
	if err := validateControlURL("http://127.0.0.1:3000"); err != nil {
		t.Fatalf("expected explicit development HTTP to pass: %v", err)
	}
}

func TestAgentStateRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "agent-state.json")
	want := agentState{NodeID: "node-1", Token: "token-1"}
	if err := saveAgentState(path, want); err != nil {
		t.Fatal(err)
	}
	got, err := loadAgentState(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("state = %#v, want %#v", got, want)
	}
}

func TestAgentStateRejectsMalformedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-state.json")
	if err := os.WriteFile(path, []byte(`{"token":"only-token"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadAgentState(path); err == nil {
		t.Fatal("expected malformed state to be rejected")
	}
}
