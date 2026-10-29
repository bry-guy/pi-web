// Tests set their own Pi/pi-web environment. Drop any inherited from the shell (e.g. when the
// suite runs inside a pi-web worker) so a host's profile, repos root or model can't leak in.
for (const name of Object.keys(process.env)) if (/^PI_/.test(name)) delete process.env[name];
