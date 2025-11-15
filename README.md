# Platform API

Node.js + Express backend API for the multi-tenant SaaS platform.

## Features

- ✅ Multi-tenant authentication (JWT)
- ✅ Product/Order CRUD
- ✅ Module health checks
- ✅ Feature flags
- ✅ Audit logging

## Development

```bash
npm install
npm start  # Port 8080
```

## Deploy

```bash
kubectl apply -f k8s/
```
