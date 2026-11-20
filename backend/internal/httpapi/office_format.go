package httpapi

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"io"

	"github.com/richardlehane/mscfb"
)

// validateOffice parses the container and the family-specific document stream.
// Names, supplied MIME types and a container signature alone do not establish format.
func validateOffice(data []byte) (string, error) {
	bad := errors.New("malformed Office document")
	if bytes.HasPrefix(data, []byte{'P', 'K'}) {
		archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return "", bad
		}
		roots := map[string]xml.Name{}
		seen := map[string]bool{}
		var types struct {
			Overrides []struct {
				PartName    string `xml:"PartName,attr"`
				ContentType string `xml:"ContentType,attr"`
			} `xml:"Override"`
		}
		var total uint64
		for _, f := range archive.File {
			if seen[f.Name] {
				return "", bad
			}
			seen[f.Name] = true
			total += f.UncompressedSize64
			if total > 100*1024*1024 {
				return "", bad
			}
			if f.FileInfo().IsDir() {
				continue
			}
			r, err := f.Open()
			if err != nil {
				return "", bad
			}
			b, err := io.ReadAll(io.LimitReader(r, 100*1024*1024+1))
			r.Close()
			if err != nil {
				return "", bad
			}
			if f.Name == "[Content_Types].xml" {
				if xml.Unmarshal(b, &types) != nil {
					return "", bad
				}
			}
			if len(f.Name) > 4 && f.Name[len(f.Name)-4:] == ".xml" {
				d := xml.NewDecoder(bytes.NewReader(b))
				var root xml.Name
				depth := 0
				for {
					tok, err := d.Token()
					if err == io.EOF {
						break
					}
					if err != nil {
						return "", bad
					}
					switch v := tok.(type) {
					case xml.StartElement:
						if depth == 0 {
							if root.Local != "" {
								return "", bad
							}
							root = v.Name
						}
						depth++
					case xml.EndElement:
						depth--
					}
				}
				if root.Local == "" || depth != 0 {
					return "", bad
				}
				if _, exists := roots[f.Name]; exists {
					return "", bad
				}
				roots[f.Name] = root
			}
		}
		if roots["[Content_Types].xml"].Local != "Types" {
			return "", bad
		}
		declared := map[string]string{}
		for _, override := range types.Overrides {
			declared[override.PartName] = override.ContentType
		}
		word := roots["word/document.xml"]
		sheet := roots["xl/workbook.xml"]
		if word.Local == "document" && word.Space == "http://schemas.openxmlformats.org/wordprocessingml/2006/main" && sheet.Local == "" && declared["/word/document.xml"] == "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" {
			return "docx", nil
		}
		if sheet.Local == "workbook" && sheet.Space == "http://schemas.openxmlformats.org/spreadsheetml/2006/main" && word.Local == "" && declared["/xl/workbook.xml"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" {
			return "xlsx", nil
		}
		return "", bad
	}
	cfb, err := mscfb.New(bytes.NewReader(data))
	if err != nil {
		return "", bad
	}
	streams := map[string][]byte{}
	for {
		f, err := cfb.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", bad
		}
		if f.Size < 0 || f.Size > 100*1024*1024 {
			return "", bad
		}
		b, err := io.ReadAll(io.LimitReader(cfb, f.Size+1))
		if err != nil || int64(len(b)) != f.Size {
			return "", bad
		}
		if len(f.Path) == 0 {
			streams[f.Name] = b
		}
	}
	if b := streams["WordDocument"]; len(b) >= 32 && binary.LittleEndian.Uint16(b[:2]) == 0xa5ec {
		flags := binary.LittleEndian.Uint16(b[10:12])
		table := "0Table"
		if flags&0x200 != 0 {
			table = "1Table"
		}
		if len(streams[table]) > 0 && flags&0x100 == 0 {
			return "doc", nil
		}
	}
	for _, name := range []string{"Workbook", "Book"} {
		b := streams[name]
		if len(b) < 8 {
			continue
		}
		record := binary.LittleEndian.Uint16(b[:2])
		if record != 0x0809 && record != 0x0409 && record != 0x0209 && record != 0x0009 {
			continue
		}
		valid := false
		for len(b) >= 4 {
			id := binary.LittleEndian.Uint16(b[:2])
			size := int(binary.LittleEndian.Uint16(b[2:4]))
			if size > len(b)-4 {
				return "", bad
			}
			b = b[4+size:]
			if id == 0x000a {
				valid = true
			}
		}
		if valid && len(b) == 0 {
			return "xls", nil
		}
	}
	return "", bad
}
