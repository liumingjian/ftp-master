# Grants carry FTP-convention Rights with a Scope; uploaders become Creators

Grants no longer assign one of four cumulative Permission Levels (View, Download, Edit, Manage). They assign a set of six Rights (Browse, Download, Upload, Modify, Delete, Grant), the split that FTP servers (Serv-U, FileZilla Server) and NTFS use, merged where a web UI needs no distinction (append and create fold into Upload, directory rename/remove fold into Modify/Delete). The UI offers Presets (Read-only, Read-write, Full Control, Drop Box, ...) over per-Right checkboxes, in the style of Confluence's space permission table, so the common cases stay one click. We chose this over levels because levels cannot express upload-without-delete or a drop box, both everyday FTP setups.

Each Grant on a directory has a Scope: the whole subtree, or this level only (Serv-U "inherit", NTFS "applies to"). Grants still only ever allow. We deliberately did not adopt Serv-U's most-specific-path-wins rule, nor Confluence-style restrictions that break inheritance: both are deny in disguise. "This level only" is the answer to the resulting rule of thumb, *grant narrowly high up, broadly low down*: the UI warns when a large Organization or User Group is granted tree-wide over a large subtree.

The uploader of a file becomes its Creator: an ordinary Grant of every Right on that file, marked as the Creator Grant, so Effective Permission needs no owner rule and the grant is audited like any other. Because uploading needs only Upload, a Creator without the Grant Right on the parent directory may share the file only with principals who can already see that directory; opening it to anyone new needs the directory's Grant Right. Only holders of Grant on the directory may remove or transfer a Creator Grant.

## Consequences

- Effective Permission becomes a set of Rights (the union over reaching Grants within Scope), not a maximum level; its tests and every authorization check change accordingly. Office editing (ADR 0005) needs Modify; moving needs Modify on the source and Upload on the target.
- A Drop Box (Upload without Browse) needs upload into a directory the User cannot list; listings and the upload flow handle that explicitly.
- A Creator may restore their own file from the Recycle Bin, in addition to Grant holders on the original parent.
- Creator Grants apply to files only; folders created by a User give them nothing beyond what they already hold.
- Design evidence: prototype branch `prototype/file-browser`, variant `D1` (`prototypes/file-browser/src/VariantFtp.tsx`, `rights.ts`).
