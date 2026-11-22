import { execFileSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Paths are data, never PowerShell source. Pass only the environment needed by
// the OS utility, and resolve its executable independently of the project PATH.
const windowsAcl = `
$ErrorActionPreference = 'Stop'
$target = $env:INTIGRITI_PRIVATE_PATH
$sidType = [System.Security.Principal.SecurityIdentifier]
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $target
if ($acl.GetOwner($sidType).Value -ne $owner.Value) { exit 1 }
$trusted = @($owner.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($env:INTIGRITI_ACL_REPAIR -eq '1') {
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.GetAccessRules($true, $false, $sidType))) {
    $acl.RemoveAccessRuleSpecific($rule)
  }
  $inheritance = if ($env:INTIGRITI_ACL_DIR -eq '1') { 'ContainerInherit, ObjectInherit' } else { 'None' }
  foreach ($sid in $trusted) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl',$inheritance,'None','Allow')
    $acl.AddAccessRule($rule)
  }
  (Get-Item -Force -LiteralPath $target).SetAccessControl($acl)
  $acl = Get-Acl -LiteralPath $target
}
$access = @($acl.GetAccessRules($true, $true, $sidType))
if (!$acl.AreAccessRulesProtected -or !$access.Count -or $acl.GetOwner($sidType).Value -ne $owner.Value) { exit 1 }
foreach ($rule in $access) {
  if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value) { exit 1 }
}
`;

function privatePath(target, directory, repair) {
  const file = target instanceof URL ? fileURLToPath(target) : target;
  const before = lstatSync(file, { bigint: true });
  if (!path.isAbsolute(file) || (directory ? !before.isDirectory() : !before.isFile() || before.nlink !== 1n)) {
    throw new Error("Expected a private directory or single-link regular file.");
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    execFileSync(path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", windowsAcl], {
        windowsHide: true, stdio: "ignore", timeout: 15000,
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, INTIGRITI_PRIVATE_PATH: file,
          INTIGRITI_ACL_REPAIR: repair ? "1" : "0", INTIGRITI_ACL_DIR: directory ? "1" : "0" },
      });
  } else {
    if (before.uid !== BigInt(process.getuid())) throw new Error("Expected the current user to own the private path.");
    if (repair) {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (before.dev !== opened.dev || before.ino !== opened.ino || (!directory && opened.nlink !== 1n)) {
          throw new Error("The private path changed while opening it.");
        }
        fchmodSync(fd, directory ? 0o700 : 0o600);
      } finally { closeSync(fd); }
    }
  }
  const after = lstatSync(file, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || (!directory && after.nlink !== 1n) ||
      (process.platform !== "win32" && (after.uid !== before.uid || (after.mode & 0o077n) !== 0n))) {
    throw new Error("The path changed or has unsafe permissions.");
  }
  return after;
}

export function protectPrivatePath(target, { directory = false } = {}) {
  return privatePath(target, directory, true);
}

export function verifyPrivateFile(target) {
  return privatePath(target, false, false);
}
