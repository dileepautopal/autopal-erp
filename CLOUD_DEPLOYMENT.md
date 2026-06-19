# AUTOPAL PI System Cloud Deployment

Recommended free testing setup:

- App hosting: Render free web service
- PostgreSQL: Neon free database

## 1. Create PostgreSQL on Neon

1. Create a Neon project.
2. Copy the pooled PostgreSQL connection string.
3. Keep `sslmode=require` in the connection string if Neon provides it.

## 2. Upload Local PostgreSQL Data

Run this from a machine where PostgreSQL tools are installed.

Export local database:

```powershell
pg_dump --format=custom --file=autopal_backup.dump "postgresql://USER:PASSWORD@localhost:5432/LOCAL_DATABASE"
```

Restore to Neon:

```powershell
pg_restore --clean --if-exists --no-owner --dbname="NEON_DATABASE_URL" autopal_backup.dump
```

After restore, also run these project migrations if needed:

```powershell
psql "NEON_DATABASE_URL" -f backend/sql/create_master_company.sql
psql "NEON_DATABASE_URL" -f backend/sql/create_pi_rmkt_tables.sql
psql "NEON_DATABASE_URL" -f backend/sql/create_master_user.sql
```

Create at least one login user:

```sql
INSERT INTO master_user (user_name, pw)
VALUES ('admin', 'change_this_password');
```

## 3. Deploy App on Render

1. Push this project to GitHub.
2. In Render, create a new Web Service from the GitHub repo.
3. Use these settings:

```text
Build Command: npm install && npm run build
Start Command: npm run start:cloud
```

4. Add environment variables:

```text
NODE_ENV=production
DATABASE_SSL=true
DATABASE_URL=your Neon PostgreSQL connection string
```

## 4. Local Testing Before Upload

```powershell
npm install
npm run build
npm run start:cloud
```

Open:

```text
http://127.0.0.1:5000
```

## Notes

- In cloud, the React frontend calls the backend using the same domain.
- Locally, the frontend still calls `http://127.0.0.1:5000` during Vite dev.
- Do not commit `.env` or database passwords.
