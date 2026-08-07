// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Vendored verbatim from https://agent-plugins.org/schemas/1.0.0/ (immutable URIs
// per spec §versioning). Do not hand-edit; re-vendor if the pinned version changes.
export const pluginSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "title": "Agent Plugins Manifest",
  "description": "Machine-readable schema for plugin.json in Agent Plugins 1.0.0. The Agent Plugins specification defines additional semantic and operational requirements.",
  "type": "object",
  "properties": {
    "$schema": {
      "const": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      "description": "Canonical identifier of the plugin manifest schema for the Agent Plugins version targeted by this document."
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64,
      "pattern": "^(?!.*(?:--|\\.\\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$",
      "description": "Human-readable plugin name."
    },
    "version": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "author": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "email": {
          "type": "string"
        },
        "url": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "homepage": {
      "type": "string"
    },
    "repository": {
      "type": "string"
    },
    "license": {
      "type": "string"
    },
    "keywords": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "extensions": {
      "type": "object",
      "description": "Client-specific manifest data keyed by reverse-domain extension namespace. Agent Plugins assigns no semantics to namespace object contents.",
      "additionalProperties": {
        "type": "object"
      }
    }
  },
  "required": ["$schema", "name"],
  "additionalProperties": false
} as const;

export const mcpSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "title": "Agent Plugins MCP Configuration",
  "description": "Machine-readable schema for mcp.json in Agent Plugins 1.0.0. The Agent Plugins specification defines additional semantic and operational requirements.",
  "type": "object",
  "properties": {
    "$schema": {
      "const": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      "description": "Canonical identifier of the MCP configuration schema for the Agent Plugins version targeted by this document."
    },
    "mcpServers": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/server"
      }
    }
  },
  "required": ["$schema", "mcpServers"],
  "additionalProperties": false,
  "$defs": {
    "server": {
      "title": "MCP server",
      "oneOf": [
        {
          "$ref": "#/$defs/stdioServer"
        },
        {
          "$ref": "#/$defs/streamableHttpServer"
        },
        {
          "$ref": "#/$defs/sseServer"
        }
      ]
    },
    "stdioServer": {
      "title": "stdio MCP server",
      "type": "object",
      "properties": {
        "type": {
          "const": "stdio"
        },
        "command": {
          "type": "string",
          "minLength": 1,
          "description": "Executable token. Resolution rules are defined by the Agent Plugins specification."
        },
        "args": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "env": {
          "type": "object",
          "propertyNames": {
            "not": {
              "enum": ["PLUGIN_ROOT", "PLUGIN_DATA"]
            }
          },
          "additionalProperties": {
            "type": "string"
          }
        },
        "cwd": {
          "type": "string",
          "pattern": "^(?:\\./|\\$\\{PLUGIN_ROOT\\}(?:/|$)|\\$\\{PLUGIN_DATA\\}(?:/|$))",
          "description": "Plugin-relative, PLUGIN_ROOT-rooted, or PLUGIN_DATA-rooted working directory. Filesystem containment is validated separately."
        }
      },
      "required": ["type", "command"],
      "additionalProperties": false
    },
    "streamableHttpServer": {
      "title": "Streamable HTTP MCP server",
      "type": "object",
      "properties": {
        "type": {
          "const": "streamable-http"
        },
        "url": {
          "type": "string",
          "minLength": 1,
          "description": "MCP endpoint URL. URL semantics are defined by the Agent Plugins specification."
        },
        "headers": {
          "$ref": "#/$defs/headers"
        }
      },
      "required": ["type", "url"],
      "additionalProperties": false
    },
    "sseServer": {
      "title": "Legacy HTTP+SSE MCP server",
      "type": "object",
      "properties": {
        "type": {
          "const": "sse"
        },
        "url": {
          "type": "string",
          "minLength": 1,
          "description": "MCP endpoint URL. URL semantics are defined by the Agent Plugins specification."
        },
        "headers": {
          "$ref": "#/$defs/headers"
        }
      },
      "required": ["type", "url"],
      "additionalProperties": false
    },
    "headers": {
      "title": "HTTP headers",
      "type": "object",
      "additionalProperties": {
        "type": "string"
      }
    }
  }
} as const;
