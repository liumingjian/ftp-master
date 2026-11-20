package identity

import (
	"strings"
	"testing"
)

func TestAHashedPasswordVerifiesOnlyAgainstItself(t *testing.T) {
	hash, err := hashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(hash, "correct horse") {
		t.Fatalf("hash %q contains the password", hash)
	}
	if !verifyPassword(hash, "correct horse battery staple") {
		t.Error("the right password does not verify")
	}
	for _, wrong := range []string{"", "correct horse battery stapl", "Correct horse battery staple"} {
		if verifyPassword(hash, wrong) {
			t.Errorf("wrong password %q verifies", wrong)
		}
	}
}

func TestHashingTheSamePasswordTwiceGivesDifferentHashes(t *testing.T) {
	a, _ := hashPassword("secret")
	b, _ := hashPassword("secret")
	if a == b {
		t.Error("two hashes of one password are equal; the salt is not random")
	}
}

func TestAMalformedHashVerifiesNothing(t *testing.T) {
	for _, hash := range []string{"", "plain", "$argon2id$v=19$m=x,t=2,p=1$AAAA$AAAA", "$bcrypt$whatever"} {
		if verifyPassword(hash, "plain") {
			t.Errorf("malformed hash %q verified a password", hash)
		}
	}
}
