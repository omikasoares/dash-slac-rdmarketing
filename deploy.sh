#!/bin/bash
set -e

cd /root/projects/dash-slac-rdmarketing

git pull --ff-only origin main

docker build -t dash-slac-rdmarketing:latest .

docker service update --force dash-slac-rdmarketing_dash-slac-rdmarketing
