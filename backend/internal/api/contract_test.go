package api_test

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Regenerates the server from api/openapi.yaml and compares it with the
// committed api.gen.go, so a contract change without `make generate` fails.
func TestGeneratedCodeMatchesTheContract(t *testing.T) {
	contract := filepath.Join("..", "..", "..", "api", "openapi.yaml")
	// Read by the test process itself so `go test` caching notices contract edits.
	if _, err := os.ReadFile(contract); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	out := filepath.Join(dir, "api.gen.go")

	// The config names its output file; point it at the temporary directory
	// so the committed file is never touched.
	config, err := os.ReadFile("oapi-codegen.yaml")
	if err != nil {
		t.Fatal(err)
	}
	const committedOutput = "output: api.gen.go"
	if !bytes.Contains(config, []byte(committedOutput)) {
		t.Fatalf("oapi-codegen.yaml no longer contains %q", committedOutput)
	}
	tempConfig := filepath.Join(dir, "oapi-codegen.yaml")
	config = bytes.Replace(config, []byte(committedOutput), []byte("output: "+out), 1)
	if err := os.WriteFile(tempConfig, config, 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("go", "tool", "oapi-codegen",
		"-config", tempConfig, contract)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("oapi-codegen: %v\n%s", err, output)
	}

	fresh, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	committed, err := os.ReadFile("api.gen.go")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(fresh, committed) {
		t.Fatal("api/openapi.yaml and internal/api/api.gen.go disagree; run `make generate`")
	}
}
