package httpapi

import (
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestSourceIP(t *testing.T) {
	proxy := []netip.Prefix{netip.MustParsePrefix("10.0.0.2/32")}
	cases := []struct {
		name         string
		remoteAddr   string
		forwardedFor []string
		trusted      []netip.Prefix
		want         string
	}{
		{"direct connection", "203.0.113.7:51234", nil, nil, "203.0.113.7"},
		{"forwarded header ignored without trusted proxies", "203.0.113.7:51234", []string{"198.51.100.1"}, nil, "203.0.113.7"},
		// A client reaching the service directly cannot pose as the proxy.
		{"forwarded header ignored from a peer that is not the proxy", "203.0.113.7:51234", []string{"198.51.100.1"}, proxy, "203.0.113.7"},
		{"trusted proxy: the address it appended", "10.0.0.2:40000", []string{"198.51.100.1"}, proxy, "198.51.100.1"},
		// The client can send its own X-Forwarded-For; only the last entry,
		// appended by our proxy, is trustworthy.
		{"trusted proxy: a client-supplied prefix is ignored", "10.0.0.2:40000", []string{"1.2.3.4, 198.51.100.1"}, proxy, "198.51.100.1"},
		{"trusted proxy: across repeated headers", "10.0.0.2:40000", []string{"1.2.3.4", "198.51.100.1"}, proxy, "198.51.100.1"},
		{"trusted proxy without the header", "10.0.0.2:40000", nil, proxy, "10.0.0.2"},
		{"trusted proxy with garbage", "10.0.0.2:40000", []string{"not-an-ip"}, proxy, "10.0.0.2"},
		{"IPv6", "[2001:db8::1]:443", nil, nil, "2001:db8::1"},
		{"IPv4-mapped IPv6 is reported as IPv4", "[::ffff:192.0.2.9]:443", nil, nil, "192.0.2.9"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/api/session", nil)
			r.RemoteAddr = c.remoteAddr
			for _, v := range c.forwardedFor {
				r.Header.Add("X-Forwarded-For", v)
			}
			got := sourceIP(r, c.trusted)
			if got.String() != c.want {
				t.Errorf("sourceIP = %v, want %s", got, c.want)
			}
		})
	}
}
