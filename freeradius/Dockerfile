FROM freeradius/freeradius-server:latest-3.2-alpine

COPY clients.conf /etc/raddb/clients.conf
COPY users /etc/raddb/users

EXPOSE 1812/udp 1813/udp

CMD ["radiusd", "-f", "-X"]
