<?php

// Смарт-группы (бета, только superadmin) — см. миграцию 028.
//
// Состав смарт-группы не задают руками: он вычисляется по правилам и лежит в той же
// host_group_members, что и у обычных групп. Поэтому всё, что адресуется «группе»
// (оповещения, команды, файлы, версии агента, фильтры), работает и со смарт-группой без
// отдельной логики. Пересчёт — при сохранении группы, по кнопке и фоновой задачей раз в
// минуту (Housekeeping): касса, которая обновила агента или сменила IP, попадает в
// группу (или выпадает из неё) сама.
//
// Правила — JSON:
//   { "match": "all" | "any",
//     "conditions": [ { "field": "...", "op": "...", "value": "...", "name": "..." }, ... ] }
// Поля и операции — в FIELDS ниже.
class SmartGroups
{
    const MAX_CONDITIONS = 20;

    const TEXT_OPS = array('contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'ends_with', 'wildcard');

    // поле => допустимые операции
    const FIELDS = array(
        'store'         => array('is', 'is_not'),
        'device_type'   => array('is', 'is_not'),
        'group'         => array('in', 'not_in'),
        'hostname'      => self::TEXT_OPS,
        'display_name'  => self::TEXT_OPS,
        'username'      => self::TEXT_OPS,
        'ip'            => array('in_subnet', 'not_in_subnet'),
        'agent_version' => array('lt', 'lte', 'eq', 'gte', 'gt', 'unknown'),
        'status'        => array('is', 'is_not'),
        'silent_days'   => array('gte'),
        'pilot'         => array('is'),
        'excluded'      => array('is'),
        'variable'      => array('equals', 'not_equals', 'contains', 'set', 'not_set'),
    );

    // ---- Права ---------------------------------------------------------------------

    public static function isSmart($groupId)
    {
        $stmt = Db::get()->prepare("SELECT kind FROM host_groups WHERE id = :id");
        $stmt->execute(array('id' => (int) $groupId));
        return $stmt->fetchColumn() === 'smart';
    }

    // Адресовать оповещение/команду/файл смарт-группе может только superadmin.
    public static function targetAllowed($targetType, $targetId)
    {
        if ($targetType !== 'group' || !$targetId || AdminAuth::isSuperadmin()) {
            return true;
        }
        return !self::isSmart($targetId);
    }

    // ---- Проверка правил -------------------------------------------------------------

    // array('rules' => нормализованные правила) или array('error' => код, 'index' => №).
    public static function validate($rules)
    {
        if (!is_array($rules)) {
            return array('error' => 'rules_required');
        }
        $match = isset($rules['match']) && $rules['match'] === 'any' ? 'any' : 'all';
        $conditions = isset($rules['conditions']) && is_array($rules['conditions']) ? array_values($rules['conditions']) : array();
        if (!$conditions) {
            return array('error' => 'conditions_required');
        }
        if (count($conditions) > self::MAX_CONDITIONS) {
            return array('error' => 'too_many_conditions');
        }

        $out = array();
        foreach ($conditions as $i => $c) {
            $field = isset($c['field']) ? (string) $c['field'] : '';
            $op = isset($c['op']) ? (string) $c['op'] : '';
            $value = isset($c['value']) ? trim((string) $c['value']) : '';
            if (!isset(self::FIELDS[$field]) || !in_array($op, self::FIELDS[$field], true)) {
                return array('error' => 'invalid_condition', 'index' => $i);
            }
            $cond = array('field' => $field, 'op' => $op, 'value' => $value);

            switch ($field) {
                case 'store':
                case 'device_type':
                case 'group':
                    if ((int) $value <= 0) {
                        return array('error' => 'condition_value_required', 'index' => $i);
                    }
                    $cond['value'] = (string) (int) $value;
                    // Условие «в группе» — только по обычным группам: смарт-группа внутри
                    // смарт-группы дала бы зависимость состава от порядка пересчёта.
                    if ($field === 'group' && self::isSmart($value)) {
                        return array('error' => 'condition_group_must_be_static', 'index' => $i);
                    }
                    break;
                case 'ip':
                    foreach (array_filter(array_map('trim', explode(',', $value))) as $cidr) {
                        if (!preg_match('#^\d{1,3}(\.\d{1,3}){3}(/\d{1,2})?$#', $cidr)) {
                            return array('error' => 'invalid_subnet', 'index' => $i);
                        }
                    }
                    if ($value === '') {
                        return array('error' => 'condition_value_required', 'index' => $i);
                    }
                    break;
                case 'agent_version':
                    if ($op !== 'unknown' && !preg_match('/^\d+(\.\d+){0,3}$/', $value)) {
                        return array('error' => 'invalid_version', 'index' => $i);
                    }
                    break;
                case 'status':
                    if (!in_array($value, array('online', 'offline', 'never'), true)) {
                        return array('error' => 'invalid_condition', 'index' => $i);
                    }
                    break;
                case 'silent_days':
                    if ((int) $value < 1) {
                        return array('error' => 'condition_value_required', 'index' => $i);
                    }
                    $cond['value'] = (string) (int) $value;
                    break;
                case 'pilot':
                case 'excluded':
                    $cond['value'] = $value === '0' ? '0' : '1';
                    break;
                case 'variable':
                    $name = isset($c['name']) ? trim((string) $c['name']) : '';
                    if (!preg_match(HostVariables::NAME_PATTERN, $name)) {
                        return array('error' => 'invalid_variable_name', 'index' => $i);
                    }
                    $cond['name'] = $name;
                    break;
                default:
                    // Текстовые поля: пустое значение допустимо только для «равно»/«не равно».
                    if ($value === '' && !in_array($op, array('equals', 'not_equals'), true)) {
                        return array('error' => 'condition_value_required', 'index' => $i);
                    }
            }
            $out[] = $cond;
        }

        return array('rules' => array('match' => $match, 'conditions' => $out));
    }

    // ---- Вычисление ------------------------------------------------------------------

    // Всё, что нужно правилам, по всем кассам — одним проходом (несколько запросов на
    // весь парк, а не по запросу на кассу).
    public static function contexts()
    {
        $db = Db::get();
        $window = (int) Settings::int('online_window_seconds', 180);
        $rows = $db->query("
            SELECT p.id, p.hostname, p.display_name, p.username, p.last_ip, p.store_id, p.device_type_id,
                   p.agent_version, p.ui_agent_version, p.last_seen, p.excluded_from_stats,
                   s.is_pilot,
                   CASE WHEN p.last_seen IS NULL THEN NULL
                        ELSE (julianday('now') - julianday(p.last_seen)) * 86400.0 END AS silent_seconds
            FROM pcs p
            JOIN stores s ON s.id = p.store_id
        ")->fetchAll();

        $staticGroups = array();
        foreach ($db->query("SELECT m.pc_id, m.group_id FROM host_group_members m JOIN host_groups g ON g.id = m.group_id WHERE g.kind = 'static'") as $m) {
            $staticGroups[(int) $m['pc_id']][(int) $m['group_id']] = true;
        }

        // Переменные: все кассы / магазин / касса / обычные группы (см. effective()).
        $byScope = array('global' => array(), 'store' => array(), 'group' => array(), 'pc' => array());
        foreach ($db->query("
            SELECT v.name, v.value, v.is_secret, v.scope, v.scope_id, g.name AS scope_name
            FROM host_variables v
            LEFT JOIN host_groups g ON v.scope = 'group' AND g.id = v.scope_id
            WHERE v.scope <> 'group' OR g.kind = 'static'
        ") as $v) {
            $key = $v['scope'] === 'global' ? 0 : (int) $v['scope_id'];
            $byScope[$v['scope']][$key][] = $v;
        }

        $contexts = array();
        foreach ($rows as $r) {
            $id = (int) $r['id'];
            $groups = isset($staticGroups[$id]) ? $staticGroups[$id] : array();
            $varRows = isset($byScope['global'][0]) ? $byScope['global'][0] : array();
            if (isset($byScope['store'][(int) $r['store_id']])) {
                $varRows = array_merge($varRows, $byScope['store'][(int) $r['store_id']]);
            }
            foreach (array_keys($groups) as $gid) {
                if (isset($byScope['group'][$gid])) {
                    $varRows = array_merge($varRows, $byScope['group'][$gid]);
                }
            }
            if (isset($byScope['pc'][$id])) {
                $varRows = array_merge($varRows, $byScope['pc'][$id]);
            }

            $silent = $r['silent_seconds'] === null ? null : (float) $r['silent_seconds'];
            $contexts[] = array(
                'id'             => $id,
                'hostname'       => (string) $r['hostname'],
                'display_name'   => (string) $r['display_name'],
                'username'       => (string) $r['username'],
                'ip'             => (string) $r['last_ip'],
                'store'          => (int) $r['store_id'],
                'device_type'    => (int) $r['device_type_id'],
                'version'        => VersionCompare::lowest($r['agent_version'], $r['ui_agent_version']),
                'status'         => $silent === null ? 'never' : ($silent <= $window ? 'online' : 'offline'),
                'silent_seconds' => $silent,
                'pilot'          => (int) $r['is_pilot'] ? '1' : '0',
                'excluded'       => (int) $r['excluded_from_stats'] ? '1' : '0',
                'groups'         => $groups,
                'vars'           => HostVariables::resolve($varRows),
            );
        }
        return $contexts;
    }

    public static function matches(array $rules, array $ctx)
    {
        $any = isset($rules['match']) && $rules['match'] === 'any';
        foreach ($rules['conditions'] as $c) {
            $ok = self::condition($c, $ctx);
            if ($any && $ok) {
                return true;
            }
            if (!$any && !$ok) {
                return false;
            }
        }
        return !$any;
    }

    private static function condition(array $c, array $ctx)
    {
        $v = $c['value'];
        switch ($c['field']) {
            case 'store':
            case 'device_type':
                $eq = $ctx[$c['field']] === (int) $v;
                return $c['op'] === 'is' ? $eq : !$eq;
            case 'group':
                $in = isset($ctx['groups'][(int) $v]);
                return $c['op'] === 'in' ? $in : !$in;
            case 'hostname':
            case 'display_name':
            case 'username':
                return self::text($c['op'], $ctx[$c['field']], $v);
            case 'ip':
                $in = false;
                if ($ctx['ip'] !== '') {
                    foreach (array_filter(array_map('trim', explode(',', $v))) as $cidr) {
                        if (NetworkSiteMatcher::ipInCidr($ctx['ip'], strpos($cidr, '/') === false ? $cidr . '/32' : $cidr)) {
                            $in = true;
                            break;
                        }
                    }
                }
                return $c['op'] === 'in_subnet' ? $in : !$in;
            case 'agent_version':
                if ($c['op'] === 'unknown') {
                    return $ctx['version'] === null || $ctx['version'] === '';
                }
                if ($ctx['version'] === null || $ctx['version'] === '') {
                    return false;
                }
                $cmp = VersionCompare::compare($ctx['version'], $v);
                switch ($c['op']) {
                    case 'lt': return $cmp < 0;
                    case 'lte': return $cmp <= 0;
                    case 'eq': return $cmp === 0;
                    case 'gte': return $cmp >= 0;
                    default: return $cmp > 0;
                }
            case 'status':
                $eq = $ctx['status'] === $v;
                return $c['op'] === 'is' ? $eq : !$eq;
            case 'silent_days':
                // Ни разу не выходившая на связь касса молчит «дольше любого срока».
                return $ctx['silent_seconds'] === null || $ctx['silent_seconds'] >= (int) $v * 86400;
            case 'pilot':
            case 'excluded':
                return $ctx[$c['field']] === $v;
            case 'variable':
                $key = strtolower($c['name']);
                $set = isset($ctx['vars'][$key]);
                $value = $set ? $ctx['vars'][$key]['value'] : '';
                switch ($c['op']) {
                    case 'set': return $set;
                    case 'not_set': return !$set;
                    case 'equals': return $set && mb_strtolower($value) === mb_strtolower($v);
                    case 'not_equals': return !$set || mb_strtolower($value) !== mb_strtolower($v);
                    default: return $set && $v !== '' && mb_stripos($value, $v) !== false;
                }
        }
        return false;
    }

    // Сравнение текста без учёта регистра (в том числе кириллицы).
    private static function text($op, $subject, $needle)
    {
        $s = mb_strtolower((string) $subject);
        $n = mb_strtolower((string) $needle);
        switch ($op) {
            case 'contains': return $n !== '' && mb_strpos($s, $n) !== false;
            case 'not_contains': return $n === '' || mb_strpos($s, $n) === false;
            case 'equals': return $s === $n;
            case 'not_equals': return $s !== $n;
            case 'starts_with': return $n !== '' && mb_substr($s, 0, mb_strlen($n)) === $n;
            case 'ends_with': return $n !== '' && mb_substr($s, -mb_strlen($n)) === $n;
            case 'wildcard':
                // * — любые символы, ? — один символ: «KASSA-0?», «*-POS*».
                $re = '/^' . str_replace(array('\*', '\?'), array('.*', '.'), preg_quote($n, '/')) . '$/u';
                return preg_match($re, $s) === 1;
        }
        return false;
    }

    // id касс, подходящих под правила.
    public static function matchingIds(array $rules, array $contexts = null)
    {
        if ($contexts === null) {
            $contexts = self::contexts();
        }
        $ids = array();
        foreach ($contexts as $ctx) {
            if (self::matches($rules, $ctx)) {
                $ids[] = $ctx['id'];
            }
        }
        return $ids;
    }

    // ---- Пересчёт состава --------------------------------------------------------------

    // Пересчитать одну смарт-группу ($groupId) или все. Пишет только разницу: касса,
    // которая и была в группе, строку не меняет. Возвращает array(id группы => число касс).
    public static function refresh($groupId = null)
    {
        $db = Db::get();
        $sql = "SELECT id, name, rules FROM host_groups WHERE kind = 'smart'" . ($groupId ? ' AND id = :id' : '');
        $stmt = $db->prepare($sql);
        $stmt->execute($groupId ? array('id' => (int) $groupId) : array());
        $groups = $stmt->fetchAll();
        if (!$groups) {
            return array();
        }

        $contexts = self::contexts();
        $counts = array();
        $db->beginTransaction();
        try {
            $current = $db->prepare('SELECT pc_id FROM host_group_members WHERE group_id = :id');
            $add = $db->prepare('INSERT OR IGNORE INTO host_group_members (group_id, pc_id) VALUES (:group_id, :pc_id)');
            $remove = $db->prepare('DELETE FROM host_group_members WHERE group_id = :group_id AND pc_id = :pc_id');
            $touch = $db->prepare('UPDATE host_groups SET refreshed_at = CURRENT_TIMESTAMP WHERE id = :id');

            foreach ($groups as $g) {
                $rules = json_decode((string) $g['rules'], true);
                $checked = self::validate($rules);
                // Правила испортились (например, удалили магазин из условия) — группа
                // пустеет, а не захватывает лишние кассы.
                $want = isset($checked['rules']) ? self::matchingIds($checked['rules'], $contexts) : array();
                $want = array_fill_keys($want, true);

                $current->execute(array('id' => $g['id']));
                $have = array_fill_keys(array_map('intval', $current->fetchAll(PDO::FETCH_COLUMN)), true);

                foreach (array_diff_key($want, $have) as $pcId => $_) {
                    $add->execute(array('group_id' => $g['id'], 'pc_id' => $pcId));
                }
                foreach (array_diff_key($have, $want) as $pcId => $_) {
                    $remove->execute(array('group_id' => $g['id'], 'pc_id' => $pcId));
                }
                $touch->execute(array('id' => $g['id']));

                $added = count(array_diff_key($want, $have));
                $removed = count(array_diff_key($have, $want));
                if ($added || $removed) {
                    Logger::info("Смарт-группа '{$g['name']}' (id={$g['id']}): +{$added} −{$removed}, всего " . count($want));
                }
                $counts[(int) $g['id']] = count($want);
            }
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            throw $e;
        }
        return $counts;
    }
}
