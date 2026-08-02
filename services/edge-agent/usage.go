package main

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
)

type usageReport struct {
	ResourceID string `json:"resourceId"`
	Kind       string `json:"kind"`
	Bytes      uint64 `json:"bytes"`
}

type usageRegistry struct {
	mu        sync.Mutex
	bytes     map[string]usageReport
	pendingID string
}

func newUsageRegistry() *usageRegistry { return &usageRegistry{bytes: make(map[string]usageReport)} }

func (r *usageRegistry) add(resourceID, kind string, bytes uint64) {
	if r == nil || resourceID == "" || bytes == 0 {
		return
	}
	r.mu.Lock()
	current := r.bytes[resourceID+"\x00"+kind]
	current.ResourceID, current.Kind = resourceID, kind
	current.Bytes += bytes
	r.bytes[resourceID+"\x00"+kind] = current
	r.mu.Unlock()
}

func (r *usageRegistry) take() (string, []usageReport) {
	if r == nil {
		return "", nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]usageReport, 0, len(r.bytes))
	for _, report := range r.bytes {
		result = append(result, report)
	}
	r.bytes = make(map[string]usageReport)
	if r.pendingID == "" {
		var raw [16]byte
		if _, err := rand.Read(raw[:]); err == nil {
			r.pendingID = hex.EncodeToString(raw[:])
		}
	}
	return r.pendingID, result
}

func (r *usageRegistry) restore(reportID string, reports []usageReport) {
	r.mu.Lock()
	if reportID != "" {
		r.pendingID = reportID
	}
	r.mu.Unlock()
	for _, report := range reports {
		r.add(report.ResourceID, report.Kind, report.Bytes)
	}
}

func (r *usageRegistry) acknowledge(reportID string) {
	r.mu.Lock()
	if r.pendingID == reportID {
		r.pendingID = ""
	}
	r.mu.Unlock()
}
