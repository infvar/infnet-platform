package main

import "testing"

func TestUsageRegistryPreservesFailedBatch(t *testing.T) {
	registry := newUsageRegistry()
	registry.add("tun-1", "tunnel", 12)
	id, reports := registry.take()
	if id == "" || len(reports) != 1 || reports[0].Bytes != 12 {
		t.Fatalf("unexpected batch: id=%q reports=%#v", id, reports)
	}
	registry.restore(id, reports)
	retryID, retry := registry.take()
	if retryID != id || len(retry) != 1 || retry[0].Bytes != 12 {
		t.Fatalf("failed batch was not preserved: id=%q reports=%#v", retryID, retry)
	}
	registry.acknowledge(retryID)
	registry.add("tun-1", "tunnel", 4)
	newID, next := registry.take()
	if newID == retryID || len(next) != 1 || next[0].Bytes != 4 {
		t.Fatalf("acknowledged batch was reused: id=%q reports=%#v", newID, next)
	}
}
