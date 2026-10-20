using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CopilotShell
{
    /// <summary>
    /// Hosts the local web UI in a frameless window. There is deliberately no way to close it: the window has
    /// no close button, Alt+F4 / the taskbar's "Close window" / WM_CLOSE are ignored, and the process only
    /// exits when the launcher that started it exits (the UI's "Stop server and tunnel" button) or Windows
    /// shuts down. Exit codes: 0 normal, 2 WebView2 runtime missing, 64 bad arguments.
    /// </summary>
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            string url = null, dataDir = null;
            int parentPid = 0;
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "--url") url = args[i + 1];
                else if (args[i] == "--data-dir") dataDir = args[i + 1];
                else if (args[i] == "--parent-pid") int.TryParse(args[i + 1], out parentPid);
            }
            // Only the launcher's own loopback UI may be shown.
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || !uri.IsLoopback || uri.Scheme != "http") return 64;

            try
            {
                if (string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString())) return 2;
            }
            catch { return 2; }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new ShellForm(uri, dataDir, parentPid));
            return 0;
        }
    }

    sealed class ShellForm : Form
    {
        const int WM_NCCALCSIZE = 0x0083, WM_NCHITTEST = 0x0084, WM_NCLBUTTONDOWN = 0x00A1;
        const int WM_CLOSE = 0x0010, WM_QUERYENDSESSION = 0x0011, WM_ENDSESSION = 0x0016, WM_SYSCOMMAND = 0x0112;
        const int SC_CLOSE = 0xF060;
        const int HTCAPTION = 2, HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13,
            HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;
        const int WS_THICKFRAME = 0x00040000, WS_MINIMIZEBOX = 0x00020000, WS_MAXIMIZEBOX = 0x00010000;
        const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20, DWMWA_BORDER_COLOR = 34;
        static readonly Color Bg = Color.FromArgb(10, 10, 11);          // --color-ink
        static readonly Color Border = Color.Black;
        const int Grip = 6;        // edge width that resizes
        const int CornerGrip = 14;

        readonly Uri origin;
        readonly string dataDir;
        readonly int parentPid;
        readonly WebView2 web = new WebView2();
        readonly Timer parentWatch = new Timer { Interval = 1000 };
        readonly Timer retry = new Timer { Interval = 2000 };
        bool allowClose;

        public ShellForm(Uri uri, string dataDir, int parentPid)
        {
            origin = uri;
            this.dataDir = dataDir;
            this.parentPid = parentPid;

            Text = "Copilot Workspace MCP";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { /* keep the default icon */ }
            FormBorderStyle = FormBorderStyle.None;
            BackColor = Bg;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(900, 620);
            Size = new Size(1380, 860);
            Padding = new Padding(Grip);   // the strip around the page is the resize border
            KeyPreview = true;

            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = Bg;
            Controls.Add(web);

            Load += async (s, e) => await InitWebView();
            retry.Tick += (s, e) => { retry.Stop(); web.Reload(); };
            parentWatch.Tick += (s, e) => WatchParent();
            parentWatch.Start();
        }

        async System.Threading.Tasks.Task InitWebView()
        {
            var env = await CoreWebView2Environment.CreateAsync(null, dataDir);
            await web.EnsureCoreWebView2Async(env);
            var c = web.CoreWebView2;
            var st = c.Settings;
            st.AreDevToolsEnabled = false;
            st.AreDefaultContextMenusEnabled = false;
            st.AreBrowserAcceleratorKeysEnabled = false;
            st.IsZoomControlEnabled = false;
            st.IsStatusBarEnabled = false;
            st.IsSwipeNavigationEnabled = false;
            st.IsPasswordAutosaveEnabled = false;
            st.IsGeneralAutofillEnabled = false;

            // The window may only ever show the launcher's own UI.
            c.NavigationStarting += (s, e) =>
            {
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var u) || u.Scheme != origin.Scheme || u.Host != origin.Host || u.Port != origin.Port)
                    e.Cancel = true;
            };
            c.NewWindowRequested += (s, e) => e.Handled = true;
            c.NavigationCompleted += (s, e) => { if (!e.IsSuccess) retry.Start(); };
            c.WebMessageReceived += OnWebMessage;
            c.Navigate(origin.ToString());
        }

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!Uri.TryCreate(e.Source, UriKind.Absolute, out var src) || src.Port != origin.Port || src.Host != origin.Host) return;
            string msg;
            try { msg = e.TryGetWebMessageAsString(); } catch { return; }
            switch (msg)
            {
                case "drag":
                    if (WindowState == FormWindowState.Normal)
                    {
                        ReleaseCapture();
                        SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                    }
                    break;
                case "min":
                    WindowState = FormWindowState.Minimized;
                    break;
                case "max":
                    WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                    break;
            }
        }

        void WatchParent()
        {
            if (parentPid <= 0) return;
            try
            {
                using (var p = Process.GetProcessById(parentPid))
                    if (!p.HasExited) return;
            }
            catch { /* no such process */ }
            allowClose = true;
            Application.Exit();
        }

        protected override CreateParams CreateParams
        {
            get
            {
                // Keep the resize/snap/minimize machinery of a normal window, with no caption or buttons.
                var cp = base.CreateParams;
                cp.Style |= WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            var m = new Margins { Left = 1, Right = 1, Top = 1, Bottom = 1 }; // gives the borderless window its drop shadow
            DwmExtendFrameIntoClientArea(Handle, ref m);

            // Windows 11: a black window outline instead of the system grey. Older Windows ignores these attributes.
            int border = Border.R | (Border.G << 8) | (Border.B << 16); // COLORREF is 0x00BBGGRR
            DwmSetWindowAttribute(Handle, DWMWA_BORDER_COLOR, ref border, sizeof(int));
            int dark = 1;
            DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            Padding = WindowState == FormWindowState.Maximized ? Padding.Empty : new Padding(Grip);
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (!allowClose && (keyData == (Keys.Alt | Keys.F4) || keyData == (Keys.Control | Keys.W))) return true;
            return base.ProcessCmdKey(ref msg, keyData);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!allowClose && e.CloseReason != CloseReason.WindowsShutDown) e.Cancel = true;
            base.OnFormClosing(e);
        }

        protected override void WndProc(ref Message m)
        {
            switch (m.Msg)
            {
                case WM_NCCALCSIZE:
                    if (m.WParam != IntPtr.Zero)
                    {
                        // The whole window is client area. When maximized Windows overhangs the screen by the
                        // frame size, so pull the rectangle back in.
                        if (WindowState == FormWindowState.Maximized)
                        {
                            var r = (Rect)Marshal.PtrToStructure(m.LParam, typeof(Rect));
                            int f = GetSystemMetrics(32) + GetSystemMetrics(92); // SM_CXSIZEFRAME + SM_CXPADDEDBORDER
                            r.Left += f; r.Top += f; r.Right -= f; r.Bottom -= f;
                            Marshal.StructureToPtr(r, m.LParam, false);
                        }
                        m.Result = IntPtr.Zero;
                        return;
                    }
                    break;
                case WM_NCHITTEST:
                    if (WindowState == FormWindowState.Normal)
                    {
                        long lp = m.LParam.ToInt64();
                        var pt = PointToClient(new Point((short)(lp & 0xFFFF), (short)((lp >> 16) & 0xFFFF)));
                        int hit = EdgeHit(pt);
                        if (hit != 0) { m.Result = (IntPtr)hit; return; }
                    }
                    break;
                case WM_QUERYENDSESSION:
                case WM_ENDSESSION:
                    allowClose = true; // never block Windows shutdown / sign-out
                    break;
                case WM_SYSCOMMAND:
                    if (!allowClose && (m.WParam.ToInt64() & 0xFFF0) == SC_CLOSE) return;
                    break;
                case WM_CLOSE:
                    if (!allowClose) return;
                    break;
            }
            base.WndProc(ref m);
        }

        int EdgeHit(Point p)
        {
            bool l = p.X < Grip, r = p.X >= ClientSize.Width - Grip, t = p.Y < Grip, b = p.Y >= ClientSize.Height - Grip;
            bool cl = p.X < CornerGrip, cr = p.X >= ClientSize.Width - CornerGrip, ct = p.Y < CornerGrip, cb = p.Y >= ClientSize.Height - CornerGrip;
            if ((l && ct) || (t && cl)) return HTTOPLEFT;
            if ((r && ct) || (t && cr)) return HTTOPRIGHT;
            if ((l && cb) || (b && cl)) return HTBOTTOMLEFT;
            if ((r && cb) || (b && cr)) return HTBOTTOMRIGHT;
            if (l) return HTLEFT;
            if (r) return HTRIGHT;
            if (t) return HTTOP;
            if (b) return HTBOTTOM;
            return 0;
        }

        [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct Margins { public int Left, Right, Top, Bottom; }
        [DllImport("user32.dll")] static extern bool ReleaseCapture();
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("dwmapi.dll")] static extern int DwmExtendFrameIntoClientArea(IntPtr hWnd, ref Margins margins);
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hWnd, int attr, ref int value, int size);
    }
}
