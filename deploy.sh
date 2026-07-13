#!/bin/bash
set -e

cd /root/projects/dash-slac-rdmarketing

git pull origin main

docker build -t dash-slac-rdmarketing:latest .

# Troque STACK_NOME_SERVICO pelo nome real depois de criar a stack no Portainer
# (descubra com: docker service ls | grep dash-slac)
docker service update --force STACK_NOME_SERVICO
