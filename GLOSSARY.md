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
A User who activates Users, maintains Organizations and User Groups, and holds every Permission Level everywhere.
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

**Grant**:
An assignment of a Permission Level on a directory or file to a User, Organization or User Group. It belongs to the item itself, so it survives renames and moves. Grants only ever allow; there is no deny.
_Avoid_: ACL entry, authorization, share

**Traversable Ancestor**:
A directory a User can open only because it lies on the path to something they hold a Grant on; inside it they see only that path. It is not a Permission Level.
_Avoid_: Parent access, browse permission

**Permission Level**:
One of View, Download, Edit, Manage, each including all lower ones. Manage adds deleting and making Grants within that scope.
_Avoid_: Role, right, privilege

**Effective Permission**:
The highest Permission Level a User holds on an item, combining Grants to the User, their Organization and its ancestors, and their User Groups, inherited down the Shared Tree.
_Avoid_: Access level, resolved permission

**File Version**:
A retained earlier content of a file, created whenever it is overwritten or saved after editing.
_Avoid_: Revision, history entry, snapshot

**Recycle Bin**:
Where deleted files and directories wait for a retention period before being purged; they can be restored from it.
_Avoid_: Trash, deleted items

**Office Plugin**:
The in-house browser extension that opens Office documents in desktop WPS inside the browser and saves them back to this system.
_Avoid_: WPS plugin, editor extension, online editor

**Stale Save**:
A save of a file whose edit started from a File Version that is no longer the latest; it is accepted and flagged.
_Avoid_: Conflict, overwrite conflict

### Audit

**Audit Event**:
An immutable record of who did what to which item, when, from where, and whether it succeeded.
_Avoid_: Log, operation log, activity
