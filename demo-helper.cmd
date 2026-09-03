@echo off
:round1
call npm run demo-reset -- --execute
call npm run mediate 241
explorer "http://127.0.0.1:3100/?purchase=241"

set /p input=Click """Add a photo""" and Press any key...
call npm run mediate 241

set /p input=Press any key to continue to round 2b...
:round2b
call npm run demo-reset -- --round 2b --execute
call npm run mediate 241
explorer "http://127.0.0.1:3100/?purchase=241&photo=carton-crushed"

set /p input=Press any key to continue to round 2c...
:round2c
call npm run demo-reset -- --round 2c --execute
call npm run mediate 241
explorer "http://127.0.0.1:3100/?purchase=241&photo=carton-crushed-padded"
