# PicVault — reverse-proxy examples (ops/)
#
# PicVault itself only listens on 127.0.0.1:7899 by default
# (APP_BIND_ADDRESS in .env). For public HTTPS access, put nginx or Caddy
# in front of it on the same host. Both examples below assume:
#   - PicVault runs at /opt/picvault and listens on 127.0.0.1:7899
#   - Your domain is img.example.com (replace it everywhere)
#   - .env has APP_PUBLIC_URL=https://img.example.com, ENABLE_HSTS=true
#     and TRUST_PROXY_HEADERS=true (install.sh sets the last two
#     automatically for https:// URLs)
#
# nginx:
#   sudo cp ops/nginx.conf /etc/nginx/sites-available/picvault
#   sudo ln -s /etc/nginx/sites-available/picvault /etc/nginx/sites-enabled/
#   sudo nginx -t && sudo systemctl reload nginx
#   # TLS via Certbot (see the README "Reverse proxy (HTTPS)" section):
#   sudo certbot --nginx -d img.example.com
#
# Caddy (automatic HTTPS, no Certbot needed):
#   sudo cp ops/Caddyfile /etc/caddy/Caddyfile   # or adapt your existing one
#   sudo systemctl reload caddy
