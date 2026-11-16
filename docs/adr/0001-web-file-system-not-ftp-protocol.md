# Web file system, not the FTP protocol

Despite the project name, ftp-master is a browser-based file management system served over HTTPS; it does not implement FTP/FTPS/SFTP. The core requirements — per-directory/file grants to Organizations and Users, online editing of Office documents, and an audit trail of every change — are hard to enforce and observe through FTP clients, while a web application controls every operation. An SFTP gateway may be added later as a secondary entry point for bulk transfer, but it must go through the same permission and audit rules.
