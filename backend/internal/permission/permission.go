// Package permission resolves Effective Permission without IO. Callers load
// membership, the ancestor chain, and descendant grants from their stores.
package permission

// Rights is a set of the six independent Rights. The zero value grants nothing.
type Rights uint8

const (
	Browse Rights = 1 << iota
	Download
	Upload
	Modify
	Delete
	GrantRight
	All = Browse | Download | Upload | Modify | Delete | GrantRight
)

// Has reports whether all requested Rights are present.
func (r Rights) Has(want Rights) bool { return r&want == want }

// Coherent adds the prerequisites of each Right and discards unknown bits.
func (r Rights) Coherent() Rights {
	r &= All
	if r.Has(GrantRight) {
		return All
	}
	if r.Has(Modify) {
		r |= Download
	}
	if r&(Download|Modify|Delete) != 0 {
		r |= Browse
	}
	return r
}

type PrincipalKind string

const (
	UserPrincipal         PrincipalKind = "user"
	OrganizationPrincipal PrincipalKind = "organization"
	UserGroupPrincipal    PrincipalKind = "user_group"
)

type Principal struct {
	Kind PrincipalKind
	ID   int64
}

type Scope string

const (
	Subtree       Scope = "subtree"
	ThisLevelOnly Scope = "this_level_only"
)

// Grant represents an allow-only assignment. Creator Grants use the same
// representation and resolution as every other Grant.
type Grant struct {
	Principal Principal
	Rights    Rights
	Scope     Scope
}

// User's OrganizationIDs includes their own Organization and all its ancestors.
// Deactivated overrides Administrator. Callers must authenticate the User first.
type User struct {
	ID              int64
	OrganizationIDs []int64
	UserGroupIDs    []int64
	Administrator   bool
	Deactivated     bool
}

// Node is one element of a root-to-target ancestor chain, including the target.
// All elements preceding the target must be directories.
type Node struct {
	IsFile bool
	Grants []Grant
}
type Result struct {
	Rights              Rights
	TraversableAncestor bool
}

// Evaluate unions the Grants reaching the target. descendantGrants must contain
// only Grants strictly below that target, and are used solely to identify a
// Traversable Ancestor. They never confer Rights on the target. An empty Scope
// defaults to Subtree; unknown Scopes fail closed on ancestors.
func Evaluate(user User, chain []Node, descendantGrants []Grant) Result {
	if user.Deactivated {
		return Result{}
	}
	if user.Administrator {
		return Result{Rights: All}
	}
	if len(chain) == 0 {
		return Result{}
	}
	var rights Rights
	for i, node := range chain {
		for _, grant := range node.Grants {
			if !matches(user, grant.Principal) {
				continue
			}
			distance := len(chain) - 1 - i
			reaches := distance == 0 || grant.Scope == "" || grant.Scope == Subtree || (grant.Scope == ThisLevelOnly && distance == 1 && chain[len(chain)-1].IsFile)
			if reaches {
				rights |= grant.Rights
			}
		}
	}
	result := Result{Rights: rights.Coherent()}
	if !chain[len(chain)-1].IsFile && !result.Rights.Has(Browse) {
		for _, grant := range descendantGrants {
			if matches(user, grant.Principal) && grant.Rights.Coherent() != 0 {
				result.TraversableAncestor = true
				break
			}
		}
	}
	return result
}

func matches(user User, principal Principal) bool {
	if principal.ID <= 0 {
		return false
	}
	switch principal.Kind {
	case UserPrincipal:
		return user.ID == principal.ID
	case OrganizationPrincipal:
		for _, id := range user.OrganizationIDs {
			if id == principal.ID {
				return true
			}
		}
	case UserGroupPrincipal:
		for _, id := range user.UserGroupIDs {
			if id == principal.ID {
				return true
			}
		}
	}
	return false
}
