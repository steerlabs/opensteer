@echo off
if defined OPENSTEER_NODE (set "_NODE=%OPENSTEER_NODE%") else (set "_NODE=node")
if defined OPENSTEER_CLI (set "_CLI=%OPENSTEER_CLI%") else (set "_CLI=%~dp0..\cli\opensteer-cli.mjs")
"%_NODE%" "%_CLI%" %*
