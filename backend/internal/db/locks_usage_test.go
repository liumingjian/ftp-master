package db_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestAdvisoryLocksUseHelpers fails if any Go code outside internal/db/locks.go
// invokes PostgreSQL advisory lock SQL directly. Centralizing lock acquisition
// prevents lock-ID typos and protects the canonical 725005 -> 725010 lock order.
func TestAdvisoryLocksUseHelpers(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	allowedFiles := map[string]bool{
		filepath.Join(root, "internal", "db", "locks.go"):            true,
		filepath.Join(root, "internal", "db", "locks_usage_test.go"): true,
	}

	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || allowedFiles[path] {
			return nil
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		if ast.IsGenerated(file) {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		ast.Inspect(file, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			val, err := strconv.Unquote(lit.Value)
			if err != nil {
				return true
			}
			lower := strings.ToLower(val)
			if strings.Contains(lower, "pg_advisory_xact_lock") || strings.Contains(lower, "pg_advisory_lock") {
				line := fset.Position(lit.Pos()).Line
				t.Errorf("%s:%d calls PostgreSQL advisory lock SQL directly; use db.Lock*Tx helpers in internal/db/locks.go instead", rel, line)
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
