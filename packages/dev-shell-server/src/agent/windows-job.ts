// A fixed native launcher. Executable/argv/cwd are parsed as JSON data and never
// evaluated as PowerShell. The CLI inherits the original binary stdio handles.
export const WINDOWS_JOB_LAUNCHER = String.raw`
$ErrorActionPreference = 'Stop'
$launch = $env:DEV_SHELL_JOB_LAUNCH | ConvertFrom-Json
[Environment]::SetEnvironmentVariable('DEV_SHELL_JOB_LAUNCH', $null, 'Process')
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace DevShell {
  public static class WindowsJob {
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
      public long ProcessTime, JobTime; public uint Flags;
      public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
      public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
      public BASIC_LIMIT Basic; public IO_COUNTERS Io;
      public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
      public uint cb; public IntPtr reserved, desktop, title;
      public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
      public ushort show,reservedSize; public IntPtr reservedData,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFO { public IntPtr process,thread; public uint pid,tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFO info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }

    static string Quote(string argument) {
      var result = new StringBuilder("\""); int slashes = 0;
      foreach (char value in argument) {
        if (value == '\\') { slashes++; continue; }
        if (value == '"') result.Append('\\', slashes * 2 + 1).Append('"');
        else result.Append('\\', slashes).Append(value);
        slashes = 0;
      }
      return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    public static int Run(string application, string[] arguments, string directory) {
      IntPtr job = CreateJobObject(IntPtr.Zero, null), limitsMemory = IntPtr.Zero;
      PROCESS_INFO process = new PROCESS_INFO(); bool resumed = false;
      try {
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new EXTENDED_LIMIT(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
        limitsMemory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(EXTENDED_LIMIT)));
        Marshal.StructureToPtr(limits, limitsMemory, false);
        Check(SetInformationJobObject(job, 9, limitsMemory, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))));
        var command = new StringBuilder(Quote(application));
        foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
        var startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        startup.flags = 0x100; // USESTDHANDLES
        startup.input = GetStdHandle(-10); startup.output = GetStdHandle(-11); startup.error = GetStdHandle(-12);
        Check(CreateProcess(application, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, directory, ref startup, out process)); // NO_WINDOW | SUSPENDED
        Check(AssignProcessToJobObject(job, process.process));
        if (ResumeThread(process.thread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
        resumed = true;
        if (WaitForSingleObject(process.process, 0xffffffff) != 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint code; Check(GetExitCodeProcess(process.process, out code));
        return unchecked((int)code);
      } finally {
        if (!resumed && process.process != IntPtr.Zero) TerminateProcess(process.process, 1);
        if (job != IntPtr.Zero) CloseHandle(job); // also kills surviving descendants
        if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
        if (process.process != IntPtr.Zero) CloseHandle(process.process);
        if (limitsMemory != IntPtr.Zero) Marshal.FreeHGlobal(limitsMemory);
      }
    }
  }
}
'@
exit ([DevShell.WindowsJob]::Run([string]$launch.command, [string[]]$launch.args, [string]$launch.cwd))
`;
