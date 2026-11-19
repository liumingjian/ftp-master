// Package clock is the single source of time for the service.
//
// Every piece of time-dependent code reads the current time through a Clock
// instead of calling the time package directly, so tests can advance time
// deterministically rather than sleeping. clock_usage_test.go enforces this.
package clock

import (
	"sync"
	"time"
)

// Clock reports the current time.
type Clock interface {
	Now() time.Time
}

// System is the Clock backed by the operating system's wall clock.
type System struct{}

// Now returns the current wall-clock time.
func (System) Now() time.Time { return time.Now() }

// Fake is a Clock that only moves when told to. It is safe for concurrent use.
type Fake struct {
	mu  sync.Mutex
	now time.Time
}

// NewFake returns a Fake clock reading start.
func NewFake(start time.Time) *Fake { return &Fake{now: start} }

// Now returns the fake's current time.
func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

// Advance moves the fake's time forward by d.
func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
}
