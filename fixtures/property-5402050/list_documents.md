<!-- MCP tool: list_documents — arguments: property_id=5402050, per_page=100 -->

The MCP server returned an error instead of a document list:

```
Invalid API key. Check your PROPSTACK_API_KEY. Manage keys at crm.propstack.de/app/admin/api_keys
```

Other tools succeeded in the same session; retry `list_documents` after verifying API key permissions for the documents endpoint if needed.
