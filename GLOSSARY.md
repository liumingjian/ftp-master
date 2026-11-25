# ftp-master

A web-based enterprise file management system: signed-in users browse, upload, download and edit files in a shared directory tree, under administrator-granted permissions, with every change audited.

## Language

### People and membership

**User**:
A person with an account in the system. Only signed-in, active Users can access anything.
_Avoid_: Account, member, client

**Registration**:
A person's request for a User account; the account stays pending until an Administrator activates it and assigns its Organization.
_Avoid_: Sign-up, application

**Administrator**:
A User who activates Users, maintains Organizations and User Groups, and holds every Right everywhere.
_Avoid_: Admin user, superuser, manager

**Organization**:
A unit in the company's department hierarchy; each User belongs to exactly one.
_Avoid_: Department, org unit, team

**User Group**:
A set of Users maintained inside this system, independent of the Organization hierarchy, typically to gather cross-department project members. A User may belong to many.
_Avoid_: Group, role, team

### Files and access

**Shared Tree**:
The single directory hierarchy all files live in; its top-level directories are created by Administrators.
_Avoid_: Space, drive, repository, personal space

**Top-level Directory**:
A directory directly under the root of the Shared Tree, created only by Administrators; the natural unit for assigning a department's or project's access.
_Avoid_: Space, root folder, drive

**Grant**:
An assignment of a set of Rights on a directory or file to a User, Organization or User Group, with a Scope. It belongs to the item itself, so it survives renames and moves. Grants only ever allow; there is no deny.
_Avoid_: ACL entry, authorization, share

**Traversable Ancestor**:
A directory a User can open only because it lies on the path to something they hold a Grant on; inside it they see only that path. It is not a Right.
_Avoid_: Parent access, browse permission

**Right**:
One of six independent things a Grant can allow, following FTP server convention: Browse (see contents, preview), Download, Upload (new files, new directories, a same-named upload becomes a File Version), Modify (rename, edit, restore a File Version), Delete, and Grant (make Grants within the item; implies all the others). Download, Modify and Delete require Browse; Modify requires Download.
_Avoid_: Permission Level, privilege, role

**Preset**:
A named set of Rights offered for quick selection: Browse only, Read-only, Read-write, Read-write-delete, Full Control, Drop Box (Upload without Browse). A set matching none is shown as Custom. Presets are a UI convenience; Grants store Rights.
_Avoid_: Role, level, template

**Scope**:
How far a Grant on a directory reaches: the directory and everything beneath it (the default), or this level only (the directory and the files directly in it). A Grant on a file has no Scope.
_Avoid_: Inheritance flag, propagation

**Creator**:
The User who uploaded a file. On upload they receive an automatic Grant of every Right on that file, marked as the Creator Grant. Without the Grant Right on the parent directory, they may share the file only with principals who can already see that directory.
_Avoid_: Owner, author, uploader

**Effective Permission**:
The set of Rights a User holds on an item: the union of every Grant that reaches it, to the User, their Organization and its ancestors, and their User Groups, along the Shared Tree within each Grant's Scope.
_Avoid_: Access level, resolved permission

**File Version**:
A retained earlier content of a file, created whenever it is overwritten or saved after editing.
_Avoid_: Revision, history entry, snapshot

**Recycle Bin**:
Where deleted files and directories wait for a retention period before being purged; they can be restored from it.
_Avoid_: Trash, deleted items

**Office Plugin**:
The in-house browser extension that starts edits in WPS from the file browser and submits the edited files to this system.
_Avoid_: WPS plugin, editor extension, online editor

**Document Gateway**:
The address that delivers one File Version for editing under an Edit Permit, without requiring the User's session.
_Avoid_: Proxy, WPS URL, download endpoint

**Edit Permit**:
Permission issued to a signed-in User with Modify when they start an Office edit. It lets the Office Plugin retrieve one File Version through the Document Gateway once, within a limited time. The User can submit edits after complete delivery.
_Avoid_: Token, ticket, capability, lock

**Stale Save**:
A save of a file whose edit started from a File Version that is no longer the latest; it is accepted and flagged.
_Avoid_: Conflict, overwrite conflict

### Storage

**Storage Quota**:
An Administrator-configured byte limit on an Organization or User; when absent, no limit applies at that level.
_Avoid_: Space limit, capacity authorization, allowance

**Organization Quota**:
A Storage Quota on an Organization that caps its entire subtree; explicit quotas on its nearest capped descendant Organizations and Users may not exceed it, and any unallocated remainder forms a shared pool exclusively for uncapped descendants.
_Avoid_: Department space, org capacity

**User Quota**:
A Storage Quota on a single User, bounded by their Organization's quota hierarchy.
_Avoid_: Member capacity, personal space limit

**Storage Usage**:
The stored bytes attributed to a User from retained File Versions they created (including items in the Recycle Bin, without double-counting restored versions) plus bytes reserved by their active uploads; an Organization's Storage Usage sums across the current Users in its subtree.
_Avoid_: Disk consumption, occupied space

### Audit

**Audit Event**:
An immutable record of who did what to which item, when, from where, and whether it succeeded.
_Avoid_: Log, operation log, activity

**Transfer Profile**:
The server-measured throughput summary and time-series speed samples attached to a file upload, download, or archive download Audit Event, recording how fast bytes moved and whether the transfer stalled or failed.
_Avoid_: Speed log, bandwidth metrics, traffic stats
