package clock_test

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

// Functions of the time package that read or wait on the wall clock. Code
// outside package clock must go through a clock.Clock instead, and tests must
// advance a clock.Fake instead of sleeping.
var wallClockFuncs = map[string]bool{
	"Now": true, "Since": true, "Until": true, "Sleep": true,
	"After": true, "AfterFunc": true, "Tick": true, "NewTimer": true, "NewTicker": true,
}

func TestTimeIsOnlyReadThroughTheClock(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	clockFile := filepath.Join(root, "internal", "clock", "clock.go")

	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || path == clockFile {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly|parser.ParseComments)
		if err != nil {
			return err
		}
		if ast.IsGenerated(file) {
			return nil
		}
		timeName := importName(file, "time")
		if timeName == "" {
			return nil
		}
		fset := token.NewFileSet()
		file, err = parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if pkg, ok := sel.X.(*ast.Ident); ok && pkg.Name == timeName && wallClockFuncs[sel.Sel.Name] {
				rel, _ := filepath.Rel(root, path)
				t.Errorf("%s:%d uses time.%s; read time through clock.Clock instead",
					rel, fset.Position(sel.Pos()).Line, sel.Sel.Name)
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func importName(file *ast.File, path string) string {
	for _, imp := range file.Imports {
		p, _ := strconv.Unquote(imp.Path.Value)
		if p != path {
			continue
		}
		if imp.Name != nil {
			return imp.Name.Name
		}
		return filepath.Base(path)
	}
	return ""
}
