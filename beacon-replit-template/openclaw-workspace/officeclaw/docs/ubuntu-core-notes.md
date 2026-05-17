# Ubuntu Core Notes

Ubuntu Core is a candidate target for an appliance-style OfficeClaw deployment because it is an immutable embedded Linux OS for edge systems. Canonical describes Ubuntu Core 24 as the latest LTS for embedded and edge deployments, with security and maintenance coverage through April 2034, minimum 512 MB RAM, minimum 1 GB storage, and support for amd64, arm64, arm32, and RISC-V hardware.

For this repository, the current build remains a local developer workspace, not a snap or production Ubuntu Core image. The next appliance step is to package the CLI plus workspace seed as a confined service and mount customer workspaces as writable data.

Source reviewed: https://ubuntu.com/download/core
