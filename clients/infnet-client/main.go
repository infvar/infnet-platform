package main

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"
)

// The client protocol is intentionally owned by infNet. It exchanges a short-lived
// tunnel ticket with the edge and multiplexes streams over a TLS session.
type config struct{ Server, Ticket, LocalAddr, RemoteName string }
type hello struct {
	Version string `json:"version"`
	Ticket  string `json:"ticket"`
	Name    string `json:"name"`
}

func main() {
	server := flag.String("server", getenv("INFNET_SERVER", "127.0.0.1:7443"), "edge tunnel endpoint")
	ticket := flag.String("ticket", os.Getenv("INFNET_TICKET"), "short-lived tunnel ticket")
	local := flag.String("local", "127.0.0.1:8080", "local service")
	name := flag.String("name", "default", "remote name")
	plaintext := flag.Bool("plaintext", false, "use plaintext only for local development")
	insecure := flag.Bool("insecure", false, "skip TLS certificate verification")
	caFile := flag.String("ca", os.Getenv("INFNET_CA_FILE"), "CA certificate file for the edge TLS certificate")
	flag.Parse()
	if *ticket == "" {
		fmt.Fprintln(os.Stderr, "-ticket or INFNET_TICKET is required")
		os.Exit(2)
	}
	for {
		if err := runSession(*server, *ticket, *local, *name, *plaintext, *insecure, *caFile); err != nil {
			fmt.Fprintf(os.Stderr, "session ended: %v; retrying in 2s\n", err)
			time.Sleep(2 * time.Second)
		}
	}
}

func runSession(server, ticket, local, name string, plaintext, insecure bool, caFile string) error {
	var conn net.Conn
	var err error
	if plaintext {
		conn, err = net.DialTimeout("tcp", server, 10*time.Second)
	} else {
		host, _, splitErr := net.SplitHostPort(server)
		if splitErr != nil {
			host = server
		}
		roots, rootErr := x509.SystemCertPool()
		if rootErr != nil {
			roots = x509.NewCertPool()
		}
		if caFile != "" {
			pem, readErr := os.ReadFile(caFile)
			if readErr != nil {
				return readErr
			}
			if !roots.AppendCertsFromPEM(pem) {
				return fmt.Errorf("failed to load CA certificate")
			}
		}
		conn, err = tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", server, &tls.Config{MinVersion: tls.VersionTLS13, ServerName: host, RootCAs: roots, InsecureSkipVerify: insecure})
	}
	if err != nil {
		return err
	}
	defer conn.Close()
	reader := bufio.NewReader(conn)
	if err := json.NewEncoder(conn).Encode(hello{Version: "infnet-client/0.2.0", Ticket: ticket, Name: name}); err != nil {
		return err
	}
	line, err := reader.ReadString('\n')
	if err != nil {
		return err
	}
	if strings.TrimSpace(line) != "READY" {
		return fmt.Errorf("edge rejected tunnel: %s", strings.TrimSpace(line))
	}
	fmt.Printf("connected to %s; forwarding %s as %s\n", server, local, name)
	for {
		line, err = reader.ReadString('\n')
		if err != nil {
			return err
		}
		if strings.TrimSpace(line) != "OPEN" {
			return fmt.Errorf("unexpected edge frame: %s", strings.TrimSpace(line))
		}
		localConn, dialErr := net.DialTimeout("tcp", local, 10*time.Second)
		if dialErr != nil {
			return dialErr
		}
		if _, err := conn.Write([]byte("CONNECTED\n")); err != nil {
			localConn.Close()
			return err
		}
		go func() { _, _ = io.Copy(conn, localConn) }()
		_, _ = io.Copy(localConn, reader)
		localConn.Close()
	}
}
func getenv(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
