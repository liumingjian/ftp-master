# Build rather than adopt an open-source file platform

Nextcloud, Seafile and ownCloud Infinite Scale already cover uploads, group grants, auditing and Office editing, yet we build our own core (permission model, audit, file metadata) and reuse only infrastructure components such as object storage. The deciding factors are deep integration with our in-house Office-editing browser plugin and the planned integration with enterprise portals for sign-on and Organization sync, both of which would fight the extension models of those products.
