package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

func TestTunnelForwardCopiesBothDirections(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()

	manager := newTunnelManager()
	payload, _ := json.Marshal(tunnelSpec{Name: "demo", Ticket: "ticket", RemotePort: port, TicketExpiresAt: time.Now().Add(time.Hour)})
	if err := manager.apply(payload); err != nil {
		t.Fatal(err)
	}

	client, edge := net.Pipe()
	manager.sessions["demo"] <- tunnelSession{conn: edge, reader: bufio.NewReader(edge)}
	remoteReady := make(chan net.Conn, 1)
	go func() {
		for {
			remote, acceptErr := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(port))
			if acceptErr == nil {
				remoteReady <- remote
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	remote := <-remoteReady
	defer remote.Close()

	line := make([]byte, len("OPEN\n"))
	if _, err := io.ReadFull(client, line); err != nil {
		t.Fatal(err)
	}
	if string(line) != "OPEN\n" {
		t.Fatalf("unexpected open frame %q", line)
	}
	if _, err := client.Write([]byte("CONNECTED\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := remote.Write([]byte("from-edge")); err != nil {
		t.Fatal(err)
	}

	buf := make([]byte, len("from-edge"))
	client.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.ReadFull(client, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "from-edge" {
		t.Fatalf("unexpected payload %q", buf)
	}
	if _, err := client.Write([]byte("to-edge")); err != nil {
		t.Fatal(err)
	}
	back := make([]byte, len("to-edge"))
	if _, err := io.ReadFull(remote, back); err != nil {
		t.Fatal(err)
	}
	if string(back) != "to-edge" {
		t.Fatalf("unexpected reverse payload %q", back)
	}
}

func TestTunnelApplyRejectsPortCollision(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()
	first := newTunnelManager()
	payload, _ := json.Marshal(tunnelSpec{Name: "first", Ticket: "ticket-1", RemotePort: port, TicketExpiresAt: time.Now().Add(time.Hour)})
	if err := first.apply(payload); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = first.listeners["first"].Close() }()
	second := newTunnelManager()
	payload, _ = json.Marshal(tunnelSpec{Name: "second", Ticket: "ticket-2", RemotePort: port, TicketExpiresAt: time.Now().Add(time.Hour)})
	if err := second.apply(payload); err == nil {
		t.Fatal("expected port collision to fail command application")
	}
}

func TestTunnelApplyRotatesTicketWithoutRebinding(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()
	manager := newTunnelManager()
	first, _ := json.Marshal(tunnelSpec{ID: "tun-1", Name: "rotating", Ticket: "old", RemotePort: port, TicketExpiresAt: time.Now().Add(time.Hour)})
	if err := manager.apply(first); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = manager.remove([]byte(`{"id":"tun-1"}`)) }()
	second, _ := json.Marshal(tunnelSpec{ID: "tun-1", Name: "rotating", Ticket: "new", RemotePort: port, TicketExpiresAt: time.Now().Add(2 * time.Hour)})
	if err := manager.apply(second); err != nil {
		t.Fatal(err)
	}
	manager.mu.RLock()
	got := manager.specs["rotating"].Ticket
	manager.mu.RUnlock()
	if got != "new" {
		t.Fatalf("ticket = %q, want new", got)
	}
}

func TestTunnelRemoveReleasesPort(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()
	manager := newTunnelManager()
	payload, _ := json.Marshal(tunnelSpec{ID: "tun-1", Name: "remove-me", Ticket: "ticket", RemotePort: port, TicketExpiresAt: time.Now().Add(time.Hour)})
	if err := manager.apply(payload); err != nil {
		t.Fatal(err)
	}
	if err := manager.remove([]byte(`{"id":"tun-1"}`)); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", ":"+strconv.Itoa(port))
	if err != nil {
		t.Fatalf("port was not released: %v", err)
	}
	_ = listener.Close()
}
