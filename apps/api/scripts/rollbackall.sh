#! /bin/bash
echo "Rolling back all migrations"
for i in ./db/migrations/*
do
  if test -f "$i"
  then
    echo "Rolling back migration $i"
    pnpm run migrate:down
  fi
done;