# Third-party references

This implementation was written from scratch. The following permissively licensed projects informed
architecture, terminology, and security decisions; no source files were copied into this repository.

- [Model Context Protocol Python SDK](https://github.com/modelcontextprotocol/python-sdk), MIT:
  Streamable HTTP server APIs and MCP tool conventions.
- [Browser Control MCP](https://github.com/eyalzh/browser-control-mcp), MIT: local-only browser
  bridge, explicit consent, audit logging, and dependency-free extension design.
- [Firefox Browser MCP](https://github.com/ICWR-TEAM/Firefox-Browser-MCP), MIT: Firefox tab,
  content-script interaction, and screenshot vocabulary. No code was copied.
- [Mozilla firefox-devtools-mcp](https://github.com/mozilla/firefox-devtools-mcp), dual MIT/Apache
  2.0: browser automation tool vocabulary only. No code was copied.

Firefox WebExtension and Native Messaging behavior follows Mozilla's public documentation.
