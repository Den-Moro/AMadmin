using System;

namespace AMadmin.UiAgent
{
    // То, что показывает окно статуса по клику на иконку в трее. Обновляется циклом опроса.
    public static class AgentState
    {
        public static string ServerUrl { get; set; } = "";
        public static string Version { get; set; } = "";
        public static DateTime? LastPollAt { get; set; }
        public static DateTime? LastSuccessAt { get; set; }
        public static bool LastPollOk { get; set; }
        public static string LastError { get; set; } = "";
        public static int ShownTotal { get; set; }
    }
}
