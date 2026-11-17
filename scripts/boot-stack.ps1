# Run at Windows startup (Task Scheduler) to start OpenWA + relay in WSL.
# Edit paths and distro name for your server.

$WslDistro = "Ubuntu"
$BootSh = "/mnt/c/WhatsappAPI/relay/scripts/boot-stack.sh"

Start-Sleep -Seconds 20
wsl -d $WslDistro -e sh $BootSh