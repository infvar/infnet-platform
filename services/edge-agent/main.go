package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

type node struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Region       string   `json:"region"`
	Capabilities []string `json:"capabilities"`
}
type envelope struct {
	Node         node   `json:"node"`
	Token        string `json:"token"`
	Address      string `json:"address"`
	AgentVersion string `json:"agentVersion"`
	CPU          int    `json:"cpu"`
	Memory       uint64 `json:"memory"`
}
type command struct {
	ID, Type string
	Payload  json.RawMessage `json:"payload"`
}
type commandResult struct {
	ID    string `json:"id"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}
type agentState struct {
	NodeID string `json:"nodeId"`
	Token  string `json:"token"`
}

func main() {
	control := getenv("INFNET_CONTROL_URL", "http://localhost:3000")
	if err := validateControlURL(control); err != nil {
		log.Fatal(err)
	}
	stateFile := getenv("INFNET_NODE_STATE_FILE", "/var/lib/infnet/agent-state.json")
	token := os.Getenv("INFNET_NODE_TOKEN")
	n := node{ID: getenv("INFNET_NODE_ID", ""), Name: getenv("INFNET_NODE_NAME", "edge-node"), Region: getenv("INFNET_NODE_REGION", "unknown"), Capabilities: []string{"cdn", "frp"}}
	if state, err := loadAgentState(stateFile); err != nil {
		log.Fatal(err)
	} else if state.Token != "" {
		token, n.ID = state.Token, state.NodeID
	}
	if token == "" {
		log.Fatal("INFNET_NODE_TOKEN or a persisted agent state is required")
	}
	if err := validateDataPlaneTLS(os.Getenv("INFNET_TLS_CERT"), os.Getenv("INFNET_TLS_KEY")); err != nil {
		log.Fatal(err)
	}
	client := &http.Client{Timeout: 15 * time.Second}
	usage := newUsageRegistry()
	manager := newTunnelManager(usage)
	cdn := newCdnManager(usage)
	cdnReady := make(chan error, 1)
	tunnelReady := make(chan error, 1)
	go func() {
		if err := cdn.serveReady(getenv("INFNET_CDN_ADDR", ":8080"), os.Getenv("INFNET_TLS_CERT"), os.Getenv("INFNET_TLS_KEY"), cdnReady); err != nil {
			log.Printf("CDN endpoint stopped: %v", err)
		}
	}()
	go func() {
		if err := serveTunnelEndpointReady(getenv("INFNET_TUNNEL_ADDR", ":7443"), os.Getenv("INFNET_TLS_CERT"), os.Getenv("INFNET_TLS_KEY"), manager, tunnelReady); err != nil {
			log.Printf("tunnel endpoint stopped: %v", err)
		}
	}()
	if err := <-cdnReady; err != nil {
		log.Fatal(err)
	}
	if err := <-tunnelReady; err != nil {
		log.Fatal(err)
	}
	rotated, err := registerUntilConnected(client, control, &token, &n)
	if err != nil {
		log.Fatal(err)
	}
	if rotated || os.Getenv("INFNET_NODE_STATE_FILE") != "" {
		if err := saveAgentState(stateFile, agentState{NodeID: n.ID, Token: token}); err != nil {
			log.Fatal(err)
		}
	}
	if err := pollCommands(client, control, token, n.ID, manager, cdn); err != nil {
		log.Printf("initial command poll failed: %v", err)
	}
	log.Printf("infNet edge agent connected: %s", n.Name)
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := heartbeat(client, control, token, n, usage); err != nil {
				log.Printf("heartbeat failed: %v", err)
			}
			if err := pollCommands(client, control, token, n.ID, manager, cdn); err != nil {
				log.Printf("command poll failed: %v", err)
			}
		}
	}
}

func validateDataPlaneTLS(certFile, keyFile string) error {
	if certFile == "" && keyFile == "" {
		if os.Getenv("INFNET_ALLOW_PLAINTEXT") == "true" {
			return nil
		}
		return fmt.Errorf("INFNET_TLS_CERT and INFNET_TLS_KEY are required; set INFNET_ALLOW_PLAINTEXT=true only for local development")
	}
	if certFile == "" || keyFile == "" {
		return fmt.Errorf("INFNET_TLS_CERT and INFNET_TLS_KEY must be provided together")
	}
	if _, err := tls.LoadX509KeyPair(certFile, keyFile); err != nil {
		return fmt.Errorf("load edge TLS certificate: %w", err)
	}
	return nil
}

func validateControlURL(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return fmt.Errorf("INFNET_CONTROL_URL must be an absolute URL")
	}
	if parsed.Scheme != "https" && os.Getenv("INFNET_ALLOW_PLAINTEXT") != "true" {
		return fmt.Errorf("INFNET_CONTROL_URL must use HTTPS; set INFNET_ALLOW_PLAINTEXT=true only for local development")
	}
	return nil
}

func register(c *http.Client, base string, token *string, n *node) (bool, error) {
	b, err := json.Marshal(envelope{Node: *n, Token: *token, Address: os.Getenv("INFNET_NODE_PUBLIC_ADDR"), AgentVersion: "0.1.0", CPU: runtime.NumCPU()})
	if err != nil {
		return false, err
	}
	req, err := http.NewRequest(http.MethodPost, base+"/api/v1/agent/register", bytes.NewReader(b))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+*token)
	res, err := c.Do(req)
	if err != nil {
		return false, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return false, fmt.Errorf("control plane returned %s", res.Status)
	}
	var reply struct {
		NodeID    string `json:"nodeId"`
		NodeToken string `json:"nodeToken"`
	}
	if err := json.NewDecoder(res.Body).Decode(&reply); err != nil {
		return false, err
	}
	if reply.NodeID == "" {
		return false, fmt.Errorf("control plane did not return nodeId")
	}
	n.ID = reply.NodeID
	if reply.NodeToken != "" {
		*token = reply.NodeToken
		return true, nil
	}
	return false, nil
}

// A node may start before the control plane has finished booting or while a
// rolling deployment is in progress. Keep the data plane alive and retry
// registration with bounded exponential backoff instead of making systemd
// restart the process in a tight loop.
func registerUntilConnected(c *http.Client, base string, token *string, n *node) (bool, error) {
	delay := time.Second
	for {
		rotated, err := register(c, base, token, n)
		if err == nil {
			return rotated, nil
		}
		log.Printf("control plane registration failed: %v; retrying in %s", err, delay)
		time.Sleep(delay)
		if delay < 60*time.Second {
			delay *= 2
			if delay > 60*time.Second {
				delay = 60 * time.Second
			}
		}
	}
}

func loadAgentState(path string) (agentState, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return agentState{}, nil
	}
	if err != nil {
		return agentState{}, fmt.Errorf("read agent state: %w", err)
	}
	var state agentState
	if err := json.Unmarshal(b, &state); err != nil || state.Token == "" || state.NodeID == "" {
		return agentState{}, fmt.Errorf("invalid agent state file")
	}
	return state, nil
}

func saveAgentState(path string, state agentState) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return fmt.Errorf("create agent state directory: %w", err)
	}
	b, err := json.Marshal(state)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return fmt.Errorf("write agent state: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("commit agent state: %w", err)
	}
	return nil
}
func heartbeat(c *http.Client, base, token string, n node, usage *usageRegistry) error {
	reportID, reports := usage.take()
	err := post(c, base+"/api/v1/agent/heartbeat", token, map[string]any{"nodeId": n.ID, "name": n.Name, "status": "online", "address": os.Getenv("INFNET_NODE_PUBLIC_ADDR"), "usageReportId": reportID, "usage": reports, "at": time.Now()})
	if err != nil {
		usage.restore(reportID, reports)
	} else {
		usage.acknowledge(reportID)
	}
	return err
}
func pollCommands(c *http.Client, base, token, nodeID string, manager *tunnelManager, cdn *cdnManager) error {
	req, err := http.NewRequest(http.MethodGet, base+"/api/v1/agent/commands?nodeId="+nodeID, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("control plane returned %s", res.Status)
	}
	var result struct {
		Data []command `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return err
	}
	ids := make([]string, 0, len(result.Data))
	results := make([]commandResult, 0, len(result.Data))
	for _, cmd := range result.Data {
		log.Printf("received command %s (%s)", cmd.ID, cmd.Type)
		if err := applyCommand(cmd, manager, cdn); err != nil {
			log.Printf("command %s failed and will be retried: %v", cmd.ID, err)
			results = append(results, commandResult{ID: cmd.ID, Error: err.Error()})
			continue
		}
		ids = append(ids, cmd.ID)
		results = append(results, commandResult{ID: cmd.ID, OK: true})
	}
	if len(results) > 0 {
		if err := post(c, base+"/api/v1/agent/commands/ack", token, map[string]any{"nodeId": nodeID, "ids": ids, "results": results}); err != nil {
			return err
		}
	}
	return nil
}

func applyCommand(cmd command, manager *tunnelManager, cdn *cdnManager) error {
	switch cmd.Type {
	case "apply_tunnel":
		return manager.apply(cmd.Payload)
	case "remove_tunnel":
		return manager.remove(cmd.Payload)
	case "apply_cdn":
		return cdn.apply(cmd.Payload)
	case "remove_cdn":
		return cdn.remove(cmd.Payload)
	default:
		return fmt.Errorf("unsupported command type %q", cmd.Type)
	}
}
func post(c *http.Client, url, token string, body any) error {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("control plane returned %s", res.Status)
	}
	return nil
}
func getenv(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
