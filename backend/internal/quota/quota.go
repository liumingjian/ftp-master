// Package quota evaluates hierarchical Storage Quotas and live Storage Usage
// without IO. Callers load Organizations, Users, and exact byte usage from
// their stores into a Snapshot and pass it to Evaluate.
package quota

import (
	"fmt"
	"math"
	"strings"
)

// Organization is one node in the Organization hierarchy.
// ParentID == nil indicates a root Organization.
// QuotaBytes == nil indicates unlimited; *QuotaBytes == 0 blocks new storage.
type Organization struct {
	ID         int64
	Name       string
	ParentID   *int64
	QuotaBytes *int64
}

// User is a single User with an optional User Quota and live Storage Usage.
type User struct {
	ID             int64
	OrganizationID int64
	QuotaBytes     *int64
	CommittedBytes int64
	ReservedBytes  int64
}

// UsedBytes returns the User's total live Storage Usage (committed + reserved).
func (u User) UsedBytes() int64 {
	return u.CommittedBytes + u.ReservedBytes
}

// Snapshot is a point-in-time view of the Organization hierarchy, Users,
// configured Storage Quotas, and live Storage Usage.
type Snapshot struct {
	Organizations []Organization
	Users         []User
}

// OrganizationSummary holds live rollups for one Organization.
type OrganizationSummary struct {
	Organization
	CommittedBytes        int64
	ReservedBytes         int64
	UsedBytes             int64
	AllocatedBytes        int64
	UnallocatedBytes      *int64
	UncappedPoolUsedBytes int64
}

// PlatformSummary holds aggregate metrics across all root Organizations.
type PlatformSummary struct {
	CommittedBytes         int64
	ReservedBytes          int64
	UsedBytes              int64
	TopLevelAllocatedBytes int64
}

// Ledger holds the evaluated quota hierarchy for a Snapshot.
type Ledger struct {
	orgs        map[int64]Organization
	orgOrder    []int64
	children    map[int64][]int64
	roots       []int64
	users       map[int64]User
	userOrder   []int64
	directUsers map[int64][]int64
	summaries   map[int64]OrganizationSummary
	platform    PlatformSummary
}

func cloneInt64Ptr(p *int64) *int64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

// Evaluate builds a Ledger with live Storage Usage rollups and nearest-capped
// descendant allocation sums across the entire Organization hierarchy.
func Evaluate(snap Snapshot) *Ledger {
	l := &Ledger{
		orgs:        make(map[int64]Organization, len(snap.Organizations)),
		orgOrder:    make([]int64, 0, len(snap.Organizations)),
		children:    make(map[int64][]int64, len(snap.Organizations)),
		users:       make(map[int64]User, len(snap.Users)),
		userOrder:   make([]int64, 0, len(snap.Users)),
		directUsers: make(map[int64][]int64),
		summaries:   make(map[int64]OrganizationSummary, len(snap.Organizations)),
	}
	for _, o := range snap.Organizations {
		cp := Organization{
			ID:         o.ID,
			Name:       o.Name,
			ParentID:   cloneInt64Ptr(o.ParentID),
			QuotaBytes: cloneInt64Ptr(o.QuotaBytes),
		}
		l.orgs[o.ID] = cp
		l.orgOrder = append(l.orgOrder, o.ID)
	}
	for _, id := range l.orgOrder {
		o := l.orgs[id]
		if o.ParentID != nil {
			if _, ok := l.orgs[*o.ParentID]; ok {
				l.children[*o.ParentID] = append(l.children[*o.ParentID], id)
				continue
			}
		}
		l.roots = append(l.roots, id)
	}
	for _, u := range snap.Users {
		cp := User{
			ID:             u.ID,
			OrganizationID: u.OrganizationID,
			QuotaBytes:     cloneInt64Ptr(u.QuotaBytes),
			CommittedBytes: u.CommittedBytes,
			ReservedBytes:  u.ReservedBytes,
		}
		l.users[u.ID] = cp
		l.userOrder = append(l.userOrder, u.ID)
		l.directUsers[u.OrganizationID] = append(l.directUsers[u.OrganizationID], u.ID)
	}

	visiting := make(map[int64]bool, len(l.orgs))
	var compute func(id int64) OrganizationSummary
	compute = func(id int64) OrganizationSummary {
		if existing, ok := l.summaries[id]; ok {
			return existing
		}
		if visiting[id] {
			return OrganizationSummary{Organization: l.orgs[id]}
		}
		visiting[id] = true
		defer delete(visiting, id)

		org := l.orgs[id]
		s := OrganizationSummary{Organization: org}
		for _, uid := range l.directUsers[id] {
			u := l.users[uid]
			s.CommittedBytes += u.CommittedBytes
			s.ReservedBytes += u.ReservedBytes
			if u.QuotaBytes != nil {
				s.AllocatedBytes += *u.QuotaBytes
			} else {
				s.UncappedPoolUsedBytes += u.UsedBytes()
			}
		}
		for _, childID := range l.children[id] {
			child := compute(childID)
			s.CommittedBytes += child.CommittedBytes
			s.ReservedBytes += child.ReservedBytes
			if child.QuotaBytes != nil {
				s.AllocatedBytes += *child.QuotaBytes
			} else {
				s.AllocatedBytes += child.AllocatedBytes
				s.UncappedPoolUsedBytes += child.UncappedPoolUsedBytes
			}
		}
		s.UsedBytes = s.CommittedBytes + s.ReservedBytes
		if org.QuotaBytes != nil {
			rem := *org.QuotaBytes - s.AllocatedBytes
			if rem < 0 {
				rem = 0
			}
			s.UnallocatedBytes = &rem
		}
		l.summaries[id] = s
		return s
	}

	for _, rootID := range l.roots {
		root := compute(rootID)
		l.platform.CommittedBytes += root.CommittedBytes
		l.platform.ReservedBytes += root.ReservedBytes
		l.platform.UsedBytes += root.UsedBytes
		if root.QuotaBytes != nil {
			l.platform.TopLevelAllocatedBytes += *root.QuotaBytes
		} else {
			l.platform.TopLevelAllocatedBytes += root.AllocatedBytes
		}
	}
	for _, id := range l.orgOrder {
		if _, ok := l.summaries[id]; !ok {
			compute(id)
		}
	}
	return l
}

// Organization returns the live rollup summary for the given Organization ID.
func (l *Ledger) Organization(id int64) (OrganizationSummary, bool) {
	s, ok := l.summaries[id]
	return s, ok
}

// PlatformSummary returns platform-wide usage and top-level allocated quotas.
func (l *Ledger) PlatformSummary() PlatformSummary {
	return l.platform
}

// ViolationKind identifies why a Storage Quota or hierarchy change was refused.
type ViolationKind string

const (
	ViolationInvalidQuota           ViolationKind = "invalid_quota"
	ViolationOrganizationNotFound   ViolationKind = "organization_not_found"
	ViolationParentNotFound         ViolationKind = "parent_not_found"
	ViolationCycle                  ViolationKind = "cycle"
	ViolationQuotaBelowAllocated    ViolationKind = "quota_below_allocated"
	ViolationAncestorBudgetExceeded ViolationKind = "ancestor_budget_exceeded"
)

// Violation describes a rejected quota or hierarchy mutation with exact byte
// bounds for user-facing error messages.
type Violation struct {
	Kind             ViolationKind
	OrganizationID   int64
	OrganizationName string
	QuotaBytes       int64
	AllocatedBytes   int64
	RequiredBytes    int64
	AvailableBytes   int64
}

func (l *Ledger) snapshot() Snapshot {
	orgs := make([]Organization, 0, len(l.orgOrder))
	for _, id := range l.orgOrder {
		o := l.orgs[id]
		orgs = append(orgs, Organization{
			ID:         o.ID,
			Name:       o.Name,
			ParentID:   cloneInt64Ptr(o.ParentID),
			QuotaBytes: cloneInt64Ptr(o.QuotaBytes),
		})
	}
	users := make([]User, 0, len(l.userOrder))
	for _, id := range l.userOrder {
		u := l.users[id]
		users = append(users, User{
			ID:             u.ID,
			OrganizationID: u.OrganizationID,
			QuotaBytes:     cloneInt64Ptr(u.QuotaBytes),
			CommittedBytes: u.CommittedBytes,
			ReservedBytes:  u.ReservedBytes,
		})
	}
	return Snapshot{Organizations: orgs, Users: users}
}

func (l *Ledger) nearestCappedAncestor(startOrgID *int64) (OrganizationSummary, bool) {
	if startOrgID == nil {
		return OrganizationSummary{}, false
	}
	visited := make(map[int64]bool)
	cur := *startOrgID
	for cur != 0 {
		if visited[cur] {
			return OrganizationSummary{}, false
		}
		visited[cur] = true
		org, ok := l.orgs[cur]
		if !ok {
			return OrganizationSummary{}, false
		}
		if org.QuotaBytes != nil {
			return l.summaries[cur], true
		}
		if org.ParentID == nil {
			return OrganizationSummary{}, false
		}
		cur = *org.ParentID
	}
	return OrganizationSummary{}, false
}

func (l *Ledger) isAncestorOrSelf(candidateAncestorID, orgID int64) bool {
	visited := make(map[int64]bool)
	cur := orgID
	for cur != 0 {
		if cur == candidateAncestorID {
			return true
		}
		if visited[cur] {
			return false
		}
		visited[cur] = true
		org, ok := l.orgs[cur]
		if !ok || org.ParentID == nil {
			return false
		}
		cur = *org.ParentID
	}
	return false
}

// ValidateCreateOrganization checks whether creating a new Organization under
// parentID with quotaBytes preserves strict nested partitioning.
func (l *Ledger) ValidateCreateOrganization(parentID *int64, quotaBytes *int64) *Violation {
	if quotaBytes != nil && *quotaBytes < 0 {
		return &Violation{Kind: ViolationInvalidQuota}
	}
	if parentID != nil {
		if _, ok := l.orgs[*parentID]; !ok {
			return &Violation{Kind: ViolationParentNotFound}
		}
	}
	if quotaBytes == nil {
		return nil
	}
	ancestor, ok := l.nearestCappedAncestor(parentID)
	if !ok {
		return nil
	}
	avail := int64(0)
	if ancestor.UnallocatedBytes != nil {
		avail = *ancestor.UnallocatedBytes
	}
	if *quotaBytes > avail {
		return &Violation{
			Kind:             ViolationAncestorBudgetExceeded,
			OrganizationID:   ancestor.ID,
			OrganizationName: ancestor.Name,
			QuotaBytes:       *ancestor.QuotaBytes,
			AllocatedBytes:   ancestor.AllocatedBytes,
			RequiredBytes:    *quotaBytes,
			AvailableBytes:   avail,
		}
	}
	return nil
}

// ValidateUpdateOrganization checks whether updating and/or moving orgID to
// parentID with quotaBytes preserves acyclicity and strict nested partitioning.
func (l *Ledger) ValidateUpdateOrganization(orgID int64, parentID *int64, quotaBytes *int64) *Violation {
	if quotaBytes != nil && *quotaBytes < 0 {
		return &Violation{Kind: ViolationInvalidQuota}
	}
	if _, ok := l.orgs[orgID]; !ok {
		return &Violation{Kind: ViolationOrganizationNotFound}
	}
	if parentID != nil {
		if _, exists := l.orgs[*parentID]; !exists {
			return &Violation{Kind: ViolationParentNotFound}
		}
		if l.isAncestorOrSelf(orgID, *parentID) {
			return &Violation{Kind: ViolationCycle}
		}
	}

	nextSnap := l.snapshot()
	for i := range nextSnap.Organizations {
		if nextSnap.Organizations[i].ID == orgID {
			nextSnap.Organizations[i].ParentID = cloneInt64Ptr(parentID)
			nextSnap.Organizations[i].QuotaBytes = cloneInt64Ptr(quotaBytes)
			break
		}
	}
	nextLedger := Evaluate(nextSnap)
	nextOrg := nextLedger.summaries[orgID]

	if nextOrg.QuotaBytes != nil && nextOrg.AllocatedBytes > *nextOrg.QuotaBytes {
		return &Violation{
			Kind:             ViolationQuotaBelowAllocated,
			OrganizationID:   nextOrg.ID,
			OrganizationName: nextOrg.Name,
			QuotaBytes:       *nextOrg.QuotaBytes,
			AllocatedBytes:   nextOrg.AllocatedBytes,
			RequiredBytes:    nextOrg.AllocatedBytes,
			AvailableBytes:   *nextOrg.QuotaBytes,
		}
	}

	// Check every capped ancestor on the new parent chain.
	visited := make(map[int64]bool)
	for ancPtr := parentID; ancPtr != nil; {
		ancID := *ancPtr
		if visited[ancID] {
			break
		}
		visited[ancID] = true
		ancSummary, exists := nextLedger.summaries[ancID]
		if !exists {
			break
		}
		if ancSummary.QuotaBytes != nil && ancSummary.AllocatedBytes > *ancSummary.QuotaBytes {
			// Compute available budget in this ancestor for orgID specifically.
			newContribution := nextOrg.AllocatedBytes
			if nextOrg.QuotaBytes != nil {
				newContribution = *nextOrg.QuotaBytes
			}
			otherAllocated := ancSummary.AllocatedBytes - newContribution
			avail := *ancSummary.QuotaBytes - otherAllocated
			if avail < 0 {
				avail = 0
			}
			return &Violation{
				Kind:             ViolationAncestorBudgetExceeded,
				OrganizationID:   ancSummary.ID,
				OrganizationName: ancSummary.Name,
				QuotaBytes:       *ancSummary.QuotaBytes,
				AllocatedBytes:   otherAllocated,
				RequiredBytes:    newContribution,
				AvailableBytes:   avail,
			}
		}
		if ancSummary.QuotaBytes != nil {
			// Above a valid capped ancestor, orgID's change cannot affect higher ceilings.
			break
		}
		ancPtr = ancSummary.ParentID
	}
	return nil
}

// AncestorBudget describes the nearest capped ancestor Organization's remaining
// allocatable budget when creating or editing an Organization.
type AncestorBudget struct {
	AncestorID               int64
	AncestorName             string
	AncestorQuotaBytes       int64
	AncestorUnallocatedBytes int64
	MaxAllowedQuotaBytes     int64
}

// OrgBudgetFor returns the constraining ancestor Organization's budget for
// placing targetOrgID (nil when creating a new Organization) under parentID.
// Returns nil when no ancestor Organization has an Organization Quota.
func (l *Ledger) OrgBudgetFor(targetOrgID *int64, parentID *int64) *AncestorBudget {
	ancestor, ok := l.nearestCappedAncestor(parentID)
	if !ok {
		return nil
	}
	unallocated := int64(0)
	if ancestor.UnallocatedBytes != nil {
		unallocated = *ancestor.UnallocatedBytes
	}
	maxAllowed := unallocated
	if targetOrgID != nil {
		if target, exists := l.summaries[*targetOrgID]; exists {
			if curAnc, hasCur := l.nearestCappedAncestor(target.ParentID); hasCur && curAnc.ID == ancestor.ID {
				if target.QuotaBytes != nil {
					maxAllowed += *target.QuotaBytes
				} else {
					maxAllowed += target.AllocatedBytes
				}
			}
		}
	}
	return &AncestorBudget{
		AncestorID:               ancestor.ID,
		AncestorName:             ancestor.Name,
		AncestorQuotaBytes:       *ancestor.QuotaBytes,
		AncestorUnallocatedBytes: unallocated,
		MaxAllowedQuotaBytes:     maxAllowed,
	}
}

// UserBudgetFor returns the constraining Organization's remaining allocatable
// budget for placing userID (nil when evaluating a new User) in targetOrgID.
// Returns nil when targetOrgID does not exist or has no capped ancestor.
func (l *Ledger) UserBudgetFor(userID *int64, targetOrgID int64) *AncestorBudget {
	ancestor, ok := l.nearestCappedAncestor(&targetOrgID)
	if !ok {
		return nil
	}
	unallocated := int64(0)
	if ancestor.UnallocatedBytes != nil {
		unallocated = *ancestor.UnallocatedBytes
	}
	maxAllowed := unallocated
	if userID != nil {
		if u, exists := l.users[*userID]; exists && u.QuotaBytes != nil {
			if curAnc, hasCur := l.nearestCappedAncestor(&u.OrganizationID); hasCur && curAnc.ID == ancestor.ID {
				maxAllowed += *u.QuotaBytes
			}
		}
	}
	return &AncestorBudget{
		AncestorID:               ancestor.ID,
		AncestorName:             ancestor.Name,
		AncestorQuotaBytes:       *ancestor.QuotaBytes,
		AncestorUnallocatedBytes: unallocated,
		MaxAllowedQuotaBytes:     maxAllowed,
	}
}

// ValidateUserChange checks whether assigning userID to organizationID with
// quotaBytes preserves strict nested partitioning at every capped ancestor.
func (l *Ledger) ValidateUserChange(userID int64, organizationID int64, quotaBytes *int64) *Violation {
	if quotaBytes != nil && *quotaBytes < 0 {
		return &Violation{Kind: ViolationInvalidQuota}
	}
	if _, ok := l.orgs[organizationID]; !ok {
		return &Violation{Kind: ViolationOrganizationNotFound}
	}
	nextSnap := l.snapshot()
	found := false
	for i := range nextSnap.Users {
		if nextSnap.Users[i].ID == userID {
			nextSnap.Users[i].OrganizationID = organizationID
			nextSnap.Users[i].QuotaBytes = cloneInt64Ptr(quotaBytes)
			found = true
			break
		}
	}
	if !found {
		nextSnap.Users = append(nextSnap.Users, User{
			ID:             userID,
			OrganizationID: organizationID,
			QuotaBytes:     cloneInt64Ptr(quotaBytes),
		})
	}
	if quotaBytes == nil {
		return nil
	}
	nextLedger := Evaluate(nextSnap)
	anc, ok := nextLedger.nearestCappedAncestor(&organizationID)
	if !ok {
		return nil
	}
	if anc.AllocatedBytes > *anc.QuotaBytes {
		otherAllocated := anc.AllocatedBytes - *quotaBytes
		avail := *anc.QuotaBytes - otherAllocated
		if avail < 0 {
			avail = 0
		}
		return &Violation{
			Kind:             ViolationAncestorBudgetExceeded,
			OrganizationID:   anc.ID,
			OrganizationName: anc.Name,
			QuotaBytes:       *anc.QuotaBytes,
			AllocatedBytes:   otherAllocated,
			RequiredBytes:    *quotaBytes,
			AvailableBytes:   avail,
		}
	}
	return nil
}

// Scope identifies which Storage Quota ceiling constrains a write.
type Scope string

const (
	ScopeNone              Scope = ""
	ScopeUser              Scope = "user"
	ScopeOrganizationPool  Scope = "organization_pool"
	ScopeOrganizationTotal Scope = "organization_total"
)

// WriteDecision is the outcome of evaluating a User's byte-increasing write.
type WriteDecision struct {
	Allowed             bool
	Scope               Scope
	ConstrainingOrgID   int64
	ConstrainingOrgName string
	RequiredBytes       int64
	AvailableBytes      *int64
}

// CheckWrite evaluates whether userID can write deltaBytes more bytes.
// Zero-byte operations (deltaBytes <= 0) are always allowed even when over quota.
func (l *Ledger) CheckWrite(userID int64, deltaBytes int64) WriteDecision {
	u, ok := l.users[userID]
	if !ok {
		return WriteDecision{Allowed: true, RequiredBytes: deltaBytes}
	}
	var (
		hasLimit    bool
		minHeadroom int64
		scope       Scope
		orgID       int64
		orgName     string
	)
	consider := func(headroom int64, s Scope, oid int64, oname string) {
		if headroom < 0 {
			headroom = 0
		}
		if !hasLimit || headroom < minHeadroom {
			hasLimit = true
			minHeadroom = headroom
			scope = s
			orgID = oid
			orgName = oname
		}
	}

	if u.QuotaBytes != nil {
		consider(*u.QuotaBytes-u.UsedBytes(), ScopeUser, 0, "")
	} else if anc, hasAnc := l.nearestCappedAncestor(&u.OrganizationID); hasAnc {
		pool := int64(0)
		if anc.UnallocatedBytes != nil {
			pool = *anc.UnallocatedBytes
		}
		consider(pool-anc.UncappedPoolUsedBytes, ScopeOrganizationPool, anc.ID, anc.Name)
	}

	visited := make(map[int64]bool)
	for cur := u.OrganizationID; cur != 0; {
		if visited[cur] {
			break
		}
		visited[cur] = true
		summary, exists := l.summaries[cur]
		if !exists {
			break
		}
		if summary.QuotaBytes != nil {
			consider(*summary.QuotaBytes-summary.UsedBytes, ScopeOrganizationTotal, summary.ID, summary.Name)
		}
		if summary.ParentID == nil {
			break
		}
		cur = *summary.ParentID
	}

	decision := WriteDecision{
		Allowed:             true,
		Scope:               scope,
		ConstrainingOrgID:   orgID,
		ConstrainingOrgName: orgName,
		RequiredBytes:       deltaBytes,
	}
	if hasLimit {
		avail := minHeadroom
		decision.AvailableBytes = &avail
		if deltaBytes > 0 && deltaBytes > avail {
			decision.Allowed = false
		}
	}
	return decision
}

// User returns the evaluated User snapshot entry when present.
func (l *Ledger) User(id int64) (User, bool) {
	u, ok := l.users[id]
	return u, ok
}

// ConstrainingOrganization summarizes the single tightest ancestor Organization
// Storage Quota constraining a User, containing only aggregate metrics and never
// peer User details or Organization tree structure.
type ConstrainingOrganization struct {
	Name                     string
	QuotaBytes               int64
	UsedBytes                int64
	AllocatedBytes           int64
	UnallocatedPoolBytes     int64
	UnallocatedPoolUsedBytes int64
	RemainingBytes           int64
	ConstraintKind           Scope
}

// UserStorageSummary describes one User's self-service storage view: their own
// usage, personal User Quota, effective ceiling/headroom, and the single tightest
// constraining ancestor Organization (if any).
type UserStorageSummary struct {
	CommittedBytes           int64
	ReservedBytes            int64
	UsedBytes                int64
	QuotaBytes               *int64
	AvailableBytes           *int64
	EffectiveLimitBytes      *int64
	EffectiveUsedBytes       int64
	EffectiveScope           Scope
	ConstrainingOrganization *ConstrainingOrganization
}

// UserStorage computes the self-service storage view for userID using the same
// precedence rules as CheckWrite.
func (l *Ledger) UserStorage(userID int64) (UserStorageSummary, bool) {
	u, ok := l.users[userID]
	if !ok {
		return UserStorageSummary{}, false
	}
	used := u.UsedBytes()
	out := UserStorageSummary{
		CommittedBytes:     u.CommittedBytes,
		ReservedBytes:      u.ReservedBytes,
		UsedBytes:          used,
		QuotaBytes:         cloneInt64Ptr(u.QuotaBytes),
		EffectiveUsedBytes: used,
	}

	var (
		hasLimit    bool
		minHeadroom int64
		effLimit    int64
		effUsed     int64
		effScope    Scope
		bestOrg     *ConstrainingOrganization
	)

	considerOverall := func(headroom, limit, currentUsed int64, s Scope) {
		if headroom < 0 {
			headroom = 0
		}
		if !hasLimit || headroom < minHeadroom {
			hasLimit = true
			minHeadroom = headroom
			effLimit = limit
			effUsed = currentUsed
			effScope = s
		}
	}

	considerOrg := func(org OrganizationSummary, kind Scope, remaining int64) {
		if remaining < 0 {
			remaining = 0
		}
		pool := int64(0)
		if org.UnallocatedBytes != nil {
			pool = *org.UnallocatedBytes
		}
		if bestOrg == nil || remaining < bestOrg.RemainingBytes {
			bestOrg = &ConstrainingOrganization{
				Name:                     org.Name,
				QuotaBytes:               *org.QuotaBytes,
				UsedBytes:                org.UsedBytes,
				AllocatedBytes:           org.AllocatedBytes,
				UnallocatedPoolBytes:     pool,
				UnallocatedPoolUsedBytes: org.UncappedPoolUsedBytes,
				RemainingBytes:           remaining,
				ConstraintKind:           kind,
			}
		}
	}

	if u.QuotaBytes != nil {
		considerOverall(*u.QuotaBytes-used, *u.QuotaBytes, used, ScopeUser)
	} else if anc, hasAnc := l.nearestCappedAncestor(&u.OrganizationID); hasAnc {
		pool := int64(0)
		if anc.UnallocatedBytes != nil {
			pool = *anc.UnallocatedBytes
		}
		headroom := pool - anc.UncappedPoolUsedBytes
		considerOverall(headroom, pool, anc.UncappedPoolUsedBytes, ScopeOrganizationPool)
		considerOrg(anc, ScopeOrganizationPool, headroom)
	}

	visited := make(map[int64]bool)
	for cur := u.OrganizationID; cur != 0; {
		if visited[cur] {
			break
		}
		visited[cur] = true
		summary, exists := l.summaries[cur]
		if !exists {
			break
		}
		if summary.QuotaBytes != nil {
			headroom := *summary.QuotaBytes - summary.UsedBytes
			considerOverall(headroom, *summary.QuotaBytes, summary.UsedBytes, ScopeOrganizationTotal)
			considerOrg(summary, ScopeOrganizationTotal, headroom)
		}
		if summary.ParentID == nil {
			break
		}
		cur = *summary.ParentID
	}

	if hasLimit {
		avail := minHeadroom
		limit := effLimit
		out.AvailableBytes = &avail
		out.EffectiveLimitBytes = &limit
		out.EffectiveUsedBytes = effUsed
		out.EffectiveScope = effScope
	}
	out.ConstrainingOrganization = bestOrg
	return out, true
}

// FormatBytes formats a non-negative byte count in binary 1024-based units
// (B / KB / MB / GB / TB) matching the desktop UI convention.
func FormatBytes(bytes int64) string {
	if bytes <= 0 {
		return "0 B"
	}
	units := [...]string{"B", "KB", "MB", "GB", "TB"}
	unit := int(math.Floor(math.Log(float64(bytes)) / math.Log(1024)))
	if unit < 0 {
		unit = 0
	}
	if unit >= len(units) {
		unit = len(units) - 1
	}
	if unit == 0 {
		return fmt.Sprintf("%d B", bytes)
	}
	divisor := math.Pow(1024, float64(unit))
	val := float64(bytes) / divisor
	s := fmt.Sprintf("%.1f", val)
	s = strings.TrimSuffix(s, ".0")
	return s + " " + units[unit]
}


