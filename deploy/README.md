# Deploying the seismographs

One small droplet (1 vCPU / 1 GB is plenty — three calm poll loops, no paid RPC).

1. `doctl compute droplet create seismograph --region sfo3 --size s-1vcpu-1gb --image ubuntu-24-04-x64 --ssh-keys <key-id> --user-data-file deploy/cloud-init.yml --wait`
2. `scp .env root@<ip>:/opt/backdraft/.env` (Telegram token/chat, fee tiers, anything non-default)
3. `ssh root@<ip> 'cd /opt/backdraft && docker compose up -d'`
4. Watchtower keeps it on `ghcr.io/cdrn/backdraft:latest`; push to master = deploy.

Dashboards are bound to 127.0.0.1 on the box. Tunnel: `ssh -L 4749:localhost:4749 root@<ip>` then open http://localhost:4749.

Data lives in the `seismograph-data` Docker volume (`/app/data/{delta,funding,spread}.db`). Back it up before destroying the droplet; raw tables are the source of truth for every derived view.
