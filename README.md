# CodeAstra

Cloud computing project on AWS.

## Setup

```powershell
.\.venv\Scripts\Activate.ps1
copy .env.example .env
aws configure --profile codeastra      # paste IAM user keys, region ap-south-1
.\.venv\Scripts\python.exe check_aws.py
```

## Safety rules
- Use an IAM user (never root) with `ReadOnlyAccess` first.
- Set a billing alarm before creating resources.
- Never commit `.env`, keys, or `.pem` files.
