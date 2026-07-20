---
name: confluence
description: Search, read, and create Confluence pages using the REST API
license: MIT
compatibility: opencode
metadata:
  audience: all
---

## What I do

- Search for Confluence pages by title, label, or full-text via CQL
- Read page content (body, metadata, comments, attachments)
- List spaces and browse space contents
- Create and update pages
- Access the Confluence REST API using a personal access token

## When to use me

Use this skill when you need to:

- Find documentation or knowledge base articles on Confluence
- Read the content of a specific Confluence page
- Search across spaces for relevant information
- Create or update Confluence pages
- List available spaces or pages within a space
- Pull Confluence content into reports or summaries

## Authentication

All API calls use Bearer token authentication (available in the environment):

```bash
-H "Authorization: Bearer $CONFLUENCE_API_TOKEN"
```

## Base URL

Find the confluence base url from the environment: $CONFLUENCE_BASE_URL

## Common Commands

### Search pages (CQL)

```bash
# Search by title
curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/content/search?cql=title~\"search+term\"&limit=10" | jq '.results[] | {id, title, space: .space.key}'

# Search by label
curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/content/search?cql=label=\"my-label\"&limit=10" | jq '.results[] | {id, title}'

# Search by space + text
curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/content/search?cql=space=\"MYSPACE\"+and+text~\"keyword\"&limit=10" | jq '.results[] | {id, title}'

# Full-text search
curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/content/search?cql=siteSearch~\"search+term\"&limit=10" | jq '.results[] | {id, title, space: .space.key}'
```

### Read a page

```bash
# Get page content by ID (HTML body)
curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/content/PAGE_ID?expand=body.storage,version,space" | jq '{title, space: .space.key, version: .version.number, body: .body.storage.value}'

# Get page content in view format (cleaner HTML)
curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/content/PAGE_ID?expand=body.view" | jq '{title, body: .body.view.value}'

# Get page metadata only
curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/content/PAGE_ID?expand=version,space,ancestors" | jq '{title, space: .space.key, version: .version.number, ancestors: [.ancestors[].title]}'
```

### List spaces

```bash
# All spaces
curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/space?limit=50" | jq '.results[] | {key, name, type}'

# Specific space details
curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/space/SPACEKEY?expand=description.plain" | jq '{key, name, description: .description.plain.value}'
```

### Browse space content

```bash
# List pages in a space
curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/content?spaceKey=SPACEKEY&type=page&limit=25" | jq '.results[] | {id, title}'

# List child pages of a parent
curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/content/PAGE_ID/child/page?limit=25" | jq '.results[] | {id, title}'
```

### Get page comments

```bash
curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/content/PAGE_ID/child/comment?expand=body.view&limit=25" | jq '.results[] | {id, body: .body.view.value}'
```

### Get page attachments

```bash
curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/content/PAGE_ID/child/attachment?limit=25" | jq '.results[] | {title, mediaType, fileSize: .extensions.fileSize}'
```

### Create a page

```bash
curl -s -X POST \
  -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  -H "Content-Type: application/json" \
  "$CONFLUENCE_BASE_URL/rest/api/content" \
  -d '{
    "type": "page",
    "title": "Page Title",
    "space": {"key": "SPACEKEY"},
    "body": {
      "storage": {
        "value": "<p>Page content in HTML</p>",
        "representation": "storage"
      }
    }
  }' | jq '{id, title, space: .space.key}'
```

### Update a page

```bash
# First get current version number
VERSION=$(curl -s -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  "$CONFLUENCE_BASE_URL/rest/api/content/PAGE_ID" | jq '.version.number')

# Then update with incremented version
curl -s -X PUT \
  -H "Authorization: Bearer $CONFLUENCE_API_TOKEN" \
  -H "Content-Type: application/json" \
  "$CONFLUENCE_BASE_URL/rest/api/content/PAGE_ID" \
  -d "{
    \"type\": \"page\",
    \"title\": \"Updated Title\",
    \"version\": {\"number\": $((VERSION + 1))},
    \"body\": {
      \"storage\": {
        \"value\": \"<p>Updated content</p>\",
        \"representation\": \"storage\"
      }
    }
  }" | jq '{id, title, version: .version.number}'
```

## Tips

- **CQL (Confluence Query Language)** is used for all searches. Key operators: `=`, `~` (contains), `IN`, `AND`, `OR`
- **Pagination**: Add `&start=N` to paginate results (combine with `&limit=N`)
- **Expand**: Use `expand=` parameter to control what data is returned (e.g., `body.storage`, `version`, `space`, `ancestors`, `children.page`)
- Page body comes as HTML — pipe through `sed 's/<[^>]*>//g'` for plain text, or use the agent to parse it
- Use `jq` for clean JSON output

## Web Access

Access Confluence directly at: <$CONFLUENCE_BASE_URL/>
