param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,
    [ValidateSet("core", "full")]
    [string]$Mode = "full"
)

$ErrorActionPreference = 'Stop'
$requiredFiles = @('00_创作简报.md', '01_设定元数据.json', '02_写作约束.json', 'manifest.json')
$errors = [System.Collections.Generic.List[string]]::new()
$allowedModuleKinds = @('progression', 'urban', 'romance', 'mystery', 'historical', 'science_fiction')
$IsCore = $Mode -eq "core"
$IsFull = $Mode -eq "full"
$placeholderPatterns = @('待填写', '待生成', '占位', 'TODO', 'TBD', '未定', '暂无', '建议复核', '\{\{.*\}\}', '\{[^}]+\}', '\.\.\.')
$genericPhrases = @('很强', '性格复杂', '关系升温', '建立悬念', '很危险', '推动剧情', '制造冲突', '增强代入感', '非常重要')

function Add-Error([string]$Message) { $errors.Add($Message) }
function Has-Field($Object, [string]$Field) { return $null -ne $Object -and $null -ne $Object.PSObject.Properties[$Field] }
function Require-Field($Object, [string]$Field, [string]$Path) {
    if (-not (Has-Field $Object $Field) -or $null -eq $Object.$Field) { Add-Error "$Path 缺少字段: $Field"; return $false }
    return $true
}
function Require-Text($Object, [string]$Field, [string]$Path) {
    if (-not (Require-Field $Object $Field $Path)) { return $false }
    if ($Object.$Field -isnot [string] -or [string]::IsNullOrWhiteSpace($Object.$Field)) { Add-Error "$Path.$Field 必须是非空文本"; return $false }
    $value = $Object.$Field.Trim()
    foreach ($pattern in $placeholderPatterns) {
        if ($value -match $pattern) { Add-Error "$Path.$Field 不得包含占位符或未决标记"; break }
    }
    if ($IsFull) {
        foreach ($phrase in $genericPhrases) {
            if ($value -eq $phrase) { Add-Error "$Path.$Field 过于抽象，必须改写为可观察事实或具体选择"; break }
        }
    }
    return $true
}
function Require-Object($Object, [string]$Field, [string]$Path) {
    if (-not (Require-Field $Object $Field $Path)) { return $null }
    $value = $Object.$Field
    if ($value -is [string] -or $value -is [System.Array] -or $value -is [ValueType] -or $null -eq $value) { Add-Error "$Path.$Field 必须是对象"; return $null }
    return $value
}
function Require-Array($Object, [string]$Field, [string]$Path, [int]$Minimum = 0, [int]$Maximum = -1) {
    if (-not (Require-Field $Object $Field $Path)) { return @() }
    $value = $Object.$Field
    if ($value -is [string] -or $value -is [System.Management.Automation.PSCustomObject] -or $value -is [ValueType] -or $null -eq $value) { Add-Error "$Path.$Field 必须是数组"; return @() }
    $items = @($value)
    if ($items.Count -lt $Minimum) { Add-Error "$Path.$Field 至少需要 $Minimum 项" }
    if ($Maximum -ge 0 -and $items.Count -gt $Maximum) { Add-Error "$Path.$Field 最多允许 $Maximum 项" }
    return $items
}
function Require-Fields($Object, [string[]]$Fields, [string]$Path) { foreach ($field in $Fields) { [void](Require-Field $Object $field $Path) } }
function Require-Texts($Object, [string[]]$Fields, [string]$Path) { foreach ($field in $Fields) { [void](Require-Text $Object $field $Path) } }
function Require-TextItems($Object, [string]$Field, [string]$Path, [int]$Minimum = 0) {
    $items = @(Require-Array $Object $Field $Path $Minimum)
    for ($index = 0; $index -lt $items.Count; $index++) {
        $wrapper = [PSCustomObject]@{ value = $items[$index] }
        [void](Require-Text $wrapper 'value' "$Path.$Field[$index]")
    }
    return $items
}
function Require-ConcreteText($Object, [string]$Field, [string]$Path, [int]$MinimumLength = 6) {
    if (-not (Require-Text $Object $Field $Path)) { return $false }
    if ($Object.$Field.Trim().Length -lt $MinimumLength) { Add-Error "$Path.$Field 信息不足，至少写出具体对象、动作或结果"; return $false }
    return $true
}
function Require-NonEmptyObject($Object, [string]$Field, [string]$Path) {
    $value = Require-Object $Object $Field $Path
    if ($null -eq $value) { return $null }
    $properties = @($value.PSObject.Properties)
    if ($properties.Count -eq 0) { Add-Error "$Path.$Field 不得为空对象"; return $value }
    foreach ($property in $properties) {
        $wrapper = [PSCustomObject]@{ value = $property.Value }
        [void](Require-Text $wrapper 'value' "$Path.$Field.$($property.Name)")
    }
    return $value
}
function Test-Id([string]$Id, [string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Id) -or $Id -notmatch '^[a-z][a-z0-9-]*$') { Add-Error "$Path 必须是 ASCII slug"; return $false }
    return $true
}
function Read-JsonFile([string]$Name) {
    try { return Get-Content -LiteralPath (Join-Path $PackagePath $Name) -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { Add-Error "$Name 不是有效 JSON: $($_.Exception.Message)"; return $null }
}
function Validate-CoreGate($Gate) {
    Require-Texts $Gate @('contract_version', 'source_revision') 'core_gate'
    if ($Gate.contract_version -ne '1.0') { Add-Error 'core_gate.contract_version 必须为 1.0' }

    $direction = Require-Object $Gate 'direction' 'core_gate'
    if ($null -ne $direction) {
        foreach ($field in @('premise', 'reader_promise', 'first_500_scene', 'first_3_chapter_change', 'unit_loop', 'main_conflict')) {
            [void](Require-ConcreteText $direction $field 'core_gate.direction' 8)
        }
    }

    $protagonist = Require-Object $Gate 'protagonist' 'core_gate'
    if ($null -ne $protagonist) {
        Require-Texts $protagonist @('id', 'name') 'core_gate.protagonist'
        [void](Test-Id $protagonist.id 'core_gate.protagonist.id')
        foreach ($field in @('goal', 'misbelief')) { [void](Require-ConcreteText $protagonist $field 'core_gate.protagonist') }
        $chain = Require-Object $protagonist 'life_chain' 'core_gate.protagonist'
        if ($null -ne $chain) {
            $events = Require-Array $chain 'events' 'core_gate.protagonist.life_chain' 3 3
            foreach ($event in $events) {
                [void](Require-ConcreteText $event 'scene' 'core_gate.protagonist.life_chain.events')
                [void](Require-ConcreteText $event 'observable_change' 'core_gate.protagonist.life_chain.events')
            }
            [void](Require-ConcreteText $chain 'current_behavior' 'core_gate.protagonist.life_chain')
        }
    }

    $keyRule = Require-Object $Gate 'key_rule' 'core_gate'
    if ($null -ne $keyRule) { foreach ($field in @('rule', 'boundary', 'cost', 'dramatic_use')) { [void](Require-ConcreteText $keyRule $field 'core_gate.key_rule') } }

    $keyRelationship = Require-Object $Gate 'key_relationship' 'core_gate'
    if ($null -ne $keyRelationship) {
        Require-Text $keyRelationship 'other_id' 'core_gate.key_relationship' | Out-Null
        [void](Test-Id $keyRelationship.other_id 'core_gate.key_relationship.other_id')
        if ($null -ne $protagonist -and $keyRelationship.other_id -eq $protagonist.id) { Add-Error 'core_gate.key_relationship.other_id 不得与主角 id 相同' }
        foreach ($field in @('current_exchange', 'turning_event', 'choice_changed')) { [void](Require-ConcreteText $keyRelationship $field 'core_gate.key_relationship') }
    }

    $genreFocus = Require-Object $Gate 'genre_focus' 'core_gate'
    if ($null -ne $genreFocus) {
        Require-Text $genreFocus 'kind' 'core_gate.genre_focus' | Out-Null
        if ($genreFocus.kind -notin $allowedModuleKinds) { Add-Error 'core_gate.genre_focus.kind 不在允许的题材模块中' }
        foreach ($field in @('main_conflict_owner', 'first_unit_mechanism', 'payoff_boundary')) { [void](Require-ConcreteText $genreFocus $field 'core_gate.genre_focus') }
    }

    $anchor = Require-Object $Gate 'continuity_anchor' 'core_gate'
    if ($null -ne $anchor) { foreach ($field in @('time', 'event', 'consequence')) { [void](Require-ConcreteText $anchor $field 'core_gate.continuity_anchor' 4) } }
    [void](Require-TextItems $Gate 'open_decisions' 'core_gate')
}
function Validate-Module($Module, [string]$Path, [string[]]$CharacterIds, [string[]]$FactionIds, [bool]$Detailed = $true) {
    Require-Texts $Module @('kind') $Path
    if ($Module.kind -notin $allowedModuleKinds) { Add-Error "$Path.kind 不在允许的题材模块中"; return $null }
    if (-not $Detailed) { return $Module.kind }
    $data = Require-Object $Module 'data' $Path
    if ($null -eq $data) { return $null }
    switch ($Module.kind) {
        'progression' {
            $rules = Require-Array $data 'rules' "$Path.data" 1
            foreach ($rule in $rules) { Require-Texts $rule @('mechanism', 'boundary', 'cost', 'failure_result') "$Path.data.rules" }
            $stages = Require-Array $data 'stages' "$Path.data" 2
            foreach ($stage in $stages) { Require-Texts $stage @('name', 'entry_condition', 'new_capability', 'cannot_do', 'maintenance_cost', 'story_pressure') "$Path.data.stages" }
            $exceptions = Require-Array $data 'cross_stage_exceptions' "$Path.data" 1
            foreach ($exception in $exceptions) { Require-Texts $exception @('allowed_when', 'price', 'maximum_gap', 'not_allowed_when') "$Path.data.cross_stage_exceptions" }
            $route = Require-Object $data 'protagonist_route' "$Path.data"
            if ($null -ne $route) { Require-Texts $route @('starting_stage', 'milestones', 'blocked_by') "$Path.data.protagonist_route" }
        }
        'urban' {
            $resources = Require-Array $data 'resource_topology' "$Path.data" 1
            foreach ($resource in $resources) {
                Require-Texts $resource @('resource', 'controller_id', 'access_gate', 'price', 'story_leverage') "$Path.data.resource_topology"
                if ($resource.controller_id -notin @($CharacterIds + $FactionIds)) { Add-Error "$Path.data.resource_topology.controller_id 引用了不存在的角色或势力: $($resource.controller_id)" }
            }
            $positions = Require-Array $data 'social_positions' "$Path.data" 1
            foreach ($position in $positions) {
                Require-Texts $position @('character_id', 'position', 'available_leverage', 'institutional_boundary') "$Path.data.social_positions"
                if ($position.character_id -notin $CharacterIds) { Add-Error "$Path.data.social_positions.character_id 引用了不存在的角色: $($position.character_id)" }
            }
            Require-NonEmptyObject $data 'pressure_system' "$Path.data" | Out-Null
            $mobility = Require-Array $data 'mobility_events' "$Path.data" 3
            foreach ($event in $mobility) { Require-Texts $event @('trigger', 'gain', 'loss') "$Path.data.mobility_events" }
        }
        'romance' {
            $pair = Require-Object $data 'core_pair' "$Path.data"
            if ($null -ne $pair) {
                Require-Texts $pair @('a_id', 'b_id', 'current_relation', 'what_each_needs', 'what_each_fears', 'relationship_boundary') "$Path.data.core_pair"
                foreach ($id in @($pair.a_id, $pair.b_id)) { if ($id -notin $CharacterIds) { Add-Error "$Path.data.core_pair 引用了不存在的角色: $id" } }
                if ($pair.a_id -eq $pair.b_id) { Add-Error "$Path.data.core_pair 的 a_id 与 b_id 不得相同" }
            }
            $contract = Require-Object $data 'relational_contract' "$Path.data"
            if ($null -ne $contract) { Require-Texts $contract @('current_terms', 'benefit', 'avoidance') "$Path.data.relational_contract" }
            $beats = Require-Array $data 'beats' "$Path.data" 4
            foreach ($beat in $beats) { Require-Texts $beat @('event', 'expectation_broken', 'choice', 'emotional_cost', 'new_relation_state') "$Path.data.beats" }
            $pressure = Require-Object $data 'external_pressure' "$Path.data"
            if ($null -ne $pressure) { Require-Texts $pressure @('force', 'deadline', 'cost') "$Path.data.external_pressure" }
        }
        'mystery' {
            $truth = Require-Object $data 'case_truth' "$Path.data"
            if ($null -ne $truth) { Require-Texts $truth @('truth', 'actor', 'motive', 'method', 'hidden_cost') "$Path.data.case_truth" }
            $clues = Require-Array $data 'clue_ledger' "$Path.data" 3
            $clueIds = @()
            foreach ($clue in $clues) {
                Require-Texts $clue @('id', 'appears_in', 'visible_fact', 'actually_proves', 'who_knows', 'verification_path', 'payoff_in') "$Path.data.clue_ledger"
                if (Test-Id $clue.id "$Path.data.clue_ledger.id") { $clueIds += $clue.id }
                $knowers = @($clue.who_knows -split '[,，、\s]+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
                foreach ($id in $knowers) { if ($id -notin @($CharacterIds + $FactionIds)) { Add-Error "$Path.data.clue_ledger.who_knows 引用了不存在的角色或势力: $id" } }
            }
            if (($clueIds | Sort-Object -Unique).Count -ne $clueIds.Count) { Add-Error "$Path.data.clue_ledger.id 必须唯一" }
            $falseLeads = Require-Array $data 'false_leads' "$Path.data" 1
            foreach ($lead in $falseLeads) { Require-Texts $lead @('why_plausible', 'how_disproved') "$Path.data.false_leads" }
            $reveals = Require-Array $data 'reveal_schedule' "$Path.data" 2
            foreach ($reveal in $reveals) { Require-Texts $reveal @('question_closed', 'larger_question_opened', 'reader_reinterpretation') "$Path.data.reveal_schedule" }
        }
        'historical' {
            $institutions = Require-Array $data 'institutions' "$Path.data" 1
            foreach ($item in $institutions) { Require-Texts $item @('name', 'formal_power', 'actual_power', 'gap') "$Path.data.institutions" }
            $interests = Require-Array $data 'interest_map' "$Path.data" 1
            foreach ($item in $interests) { Require-Texts $item @('faction', 'needs', 'legitimacy', 'allies', 'secret_line') "$Path.data.interest_map" }
            $transitions = Require-Array $data 'power_transitions' "$Path.data" 1
            foreach ($item in $transitions) { Require-Texts $item @('event', 'legal_threshold', 'executor', 'beneficiary', 'backlash') "$Path.data.power_transitions" }
            $channels = Require-Array $data 'information_channels' "$Path.data" 1
            foreach ($item in $channels) { Require-Texts $item @('channel', 'speed', 'cut_method') "$Path.data.information_channels" }
        }
        'science_fiction' {
            $technologies = Require-Array $data 'technology_constraints' "$Path.data" 1
            foreach ($item in $technologies) { Require-Texts $item @('tech', 'capability', 'cost', 'boundary', 'social_cost') "$Path.data.technology_constraints" }
            $dependencies = Require-Array $data 'system_dependencies' "$Path.data" 1
            foreach ($item in $dependencies) { Require-Texts $item @('system', 'depends_on', 'break_point') "$Path.data.system_dependencies" }
            $tradeoffs = Require-Array $data 'human_tradeoffs' "$Path.data" 1
            foreach ($item in $tradeoffs) { Require-Texts $item @('gain', 'price', 'who_pays') "$Path.data.human_tradeoffs" }
            $failures = Require-Array $data 'failure_scenarios' "$Path.data" 3
            foreach ($item in $failures) { Require-Texts $item @('scenario', 'cause', 'consequence') "$Path.data.failure_scenarios" }
        }
    }
    return $Module.kind
}

if ($IsCore) {
    $gatePath = Join-Path $PackagePath '.work\core_gate.json'
    if (-not (Test-Path -LiteralPath $gatePath -PathType Leaf)) {
        Add-Error 'core 模式需要 .work/core_gate.json'
    } else {
        try {
            $gate = Get-Content -LiteralPath $gatePath -Raw -Encoding UTF8 | ConvertFrom-Json
            Validate-CoreGate $gate
        } catch {
            Add-Error ".work/core_gate.json 不是有效 JSON: $($_.Exception.Message)"
        }
    }
    if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_) }; exit 1 }
    Write-Host '方向门校验通过 [core]。'
    exit 0
}

foreach ($file in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $PackagePath $file) -PathType Leaf)) { Add-Error "缺少必需文件: $file" }
}
if (Test-Path -LiteralPath (Join-Path $PackagePath '00_创作简报.md') -PathType Leaf) {
    if ((Get-Item -LiteralPath (Join-Path $PackagePath '00_创作简报.md')).Length -lt 80) { Add-Error '00_创作简报.md 不得为空或只有占位内容' }
}
if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_) }; exit 1 }

$metadata = Read-JsonFile '01_设定元数据.json'
$constraints = Read-JsonFile '02_写作约束.json'
$manifest = Read-JsonFile 'manifest.json'

if ($errors.Count -eq 0) {
    foreach ($document in @($metadata, $constraints, $manifest)) {
        Require-Texts $document @('contract_version', 'source_revision') '根对象'
        if ($document.contract_version -ne '1.0') { Add-Error 'contract_version 必须为 1.0' }
    }
    if (($metadata.source_revision -ne $constraints.source_revision) -or ($metadata.source_revision -ne $manifest.source_revision)) { Add-Error '三个 JSON 文件的 source_revision 必须一致' }
    $gatePath = Join-Path $PackagePath '.work\core_gate.json'
    if (Test-Path -LiteralPath $gatePath -PathType Leaf) {
        try {
            $gate = Get-Content -LiteralPath $gatePath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($gate.source_revision -ne $metadata.source_revision) { Add-Error '.work/core_gate.json 的 source_revision 必须与最终设定包一致' }
        } catch { Add-Error ".work/core_gate.json 不是有效 JSON: $($_.Exception.Message)" }
    }
    Require-Fields $metadata @('novel', 'story_engine', 'world', 'characters', 'relationships', 'genre_module', 'continuity') '元数据'
    foreach ($legacyField in @('novel_meta', 'power_system', 'number_anchors', 'alternative_module')) {
        if (Has-Field $metadata $legacyField) { Add-Error "元数据不得使用已废弃字段: $legacyField" }
    }
    $novel = Require-Object $metadata 'novel' '元数据'
    if ($null -ne $novel) {
        Require-Texts $novel @('title', 'genre', 'premise', 'reader_promise', 'target_platform') 'novel'
        $trace = Require-Array $novel 'source_trace' 'novel' 1
        foreach ($item in $trace) {
            Require-Texts $item @('subject', 'origin', 'note') 'novel.source_trace'
            if ($item.origin -notin @('user', 'derived')) { Add-Error 'novel.source_trace.origin 仅可为 user 或 derived' }
        }
    }
    $engine = Require-Object $metadata 'story_engine' '元数据'
    if ($null -ne $engine) {
        $opening = Require-Object $engine 'opening_delivery' 'story_engine'
        if ($null -ne $opening) { foreach ($field in @('reader_knows', 'immediate_conflict', 'first_payoff_or_threat')) { [void](Require-ConcreteText $opening $field 'story_engine.opening_delivery') } }
        $reward = Require-Object $engine 'reward_map' 'story_engine'
        if ($null -ne $reward) {
            foreach ($field in @('core_reward', 'first_500', 'first_3_chapters', 'unit_loop', 'price_of_reward')) { [void](Require-ConcreteText $reward $field 'story_engine.reward_map') }
            if (Require-Text $reward 'cadence' 'story_engine.reward_map') {
                if ($reward.cadence -notmatch '^editorial_assumption\s*:') { Add-Error 'story_engine.reward_map.cadence 必须以 editorial_assumption: 开头，避免伪造平台事实' }
            }
        }
        $chapters = Require-Array $engine 'three_chapter_map' 'story_engine' 3 3
        $chapterNumbers = @()
        foreach ($chapter in $chapters) {
            if (Require-Field $chapter 'chapter' 'story_engine.three_chapter_map') {
                if ($chapter.chapter -isnot [ValueType]) { Add-Error 'story_engine.three_chapter_map.chapter 必须是数字' } else { $chapterNumbers += [int]$chapter.chapter }
            }
            foreach ($field in @('change', 'reader_delivery', 'ending_pull')) { [void](Require-ConcreteText $chapter $field 'story_engine.three_chapter_map' 4) }
        }
        if ((@($chapterNumbers | Sort-Object) -join ',') -ne '1,2,3') { Add-Error 'story_engine.three_chapter_map.chapter 必须恰好为 1、2、3' }
        $conflict = Require-Object $engine 'main_conflict' 'story_engine'
        if ($null -ne $conflict) { Require-Texts $conflict @('protagonist_goal', 'opposing_force', 'why_it_persists', 'failure_cost') 'story_engine.main_conflict' }
        if ($IsFull) {
            $ladder = Require-Array $engine 'escalation_ladder' 'story_engine' 3
            foreach ($step in $ladder) { Require-Texts $step @('trigger', 'what_changes', 'price') 'story_engine.escalation_ladder' }
            Require-Text $engine 'ending_question' 'story_engine' | Out-Null
        }
    }
    $world = Require-Object $metadata 'world' '元数据'
    $locationIds = @()
    $factionIds = @()
    if ($null -ne $world) {
        $rules = Require-Array $world 'rules' 'world' 1
        foreach ($rule in $rules) { Require-Texts $rule @('rule', 'boundary', 'cost', 'dramatic_use') 'world.rules' }
        $locations = Require-Array $world 'locations' 'world' 1
        foreach ($location in $locations) {
            Require-Texts $location @('id', 'name', 'importance') 'world.locations'
            if (Test-Id $location.id 'world.locations.id') { $locationIds += $location.id }
            if ($location.importance -eq 'P0') { Require-Texts $location @('geography', 'resource', 'economy') 'world.locations.P0' } else { Require-Text $location 'story_use' 'world.locations' | Out-Null }
        }
        if (($locationIds | Sort-Object -Unique).Count -ne $locationIds.Count) { Add-Error '地点 id 必须唯一' }
        if ($IsFull) {
            $factions = Require-Array $world 'factions' 'world'
            foreach ($faction in $factions) {
                Require-Texts $faction @('id', 'name', 'importance') 'world.factions'
                if (Test-Id $faction.id 'world.factions.id') { $factionIds += $faction.id }
                if ($faction.importance -eq 'P0') { Require-Texts $faction @('income', 'recruitment', 'boundary', 'reason_to_exist') 'world.factions.P0' } else { Require-Text $faction 'story_use' 'world.factions' | Out-Null }
            }
            if (($factionIds | Sort-Object -Unique).Count -ne $factionIds.Count) { Add-Error '势力 id 必须唯一' }
        }
    }
    $characters = Require-Array $metadata 'characters' '元数据' 1
    $characterIds = @()
    $protagonistIds = @()
    foreach ($character in $characters) {
        Require-Texts $character @('id', 'name', 'priority', 'role', 'current_goal', 'misbelief', 'line_in_the_sand', 'resources', 'cost_or_vulnerability', 'pressure_tell', 'status') 'characters'
        if (Test-Id $character.id 'characters.id') { $characterIds += $character.id }
        if ($character.priority -notin @('P0', 'P1', 'P2')) { Add-Error "角色 priority 无效: $($character.name)" }
        if ($character.role -eq '主角') { $protagonistIds += $character.id }
        if ($character.status -notin @('alive', 'dead')) { Add-Error "角色 status 无效: $($character.name)" }
        if ($character.status -eq 'dead') { Require-Texts $character @('death_time', 'death_cause') 'characters.dead' }
        if ($character.priority -eq 'P0') {
            Require-Text $character 'naming_rationale' 'characters.P0' | Out-Null
            $chain = Require-Object $character 'life_chain' 'characters.P0'
            if ($null -ne $chain) {
                $events = Require-Array $chain 'events' 'characters.P0.life_chain' 3 3
                foreach ($event in $events) {
                    [void](Require-ConcreteText $event 'scene' 'characters.P0.life_chain.events')
                    [void](Require-ConcreteText $event 'observable_change' 'characters.P0.life_chain.events')
                }
                [void](Require-ConcreteText $chain 'current_behavior' 'characters.P0.life_chain')
            }
        }
        if ($character.priority -eq 'P1') { Require-Texts $character @('origin_event', 'current_behavior') 'characters.P1' }
    }
    if (($characterIds | Sort-Object -Unique).Count -ne $characterIds.Count) { Add-Error '角色 id 必须唯一' }
    $allEntityIds = @($characterIds + $locationIds + $factionIds)
    if (($allEntityIds | Sort-Object -Unique).Count -ne $allEntityIds.Count) { Add-Error '角色、地点与势力 id 必须全局唯一' }
    if ($protagonistIds.Count -ne 1) { Add-Error '必须且只能有一位 role 为 主角 的角色' }
    $relationships = Require-Array $metadata 'relationships' '元数据' 1
    $linksProtagonist = $false
    $relationshipKeys = @()
    foreach ($relationship in $relationships) {
        Require-Texts $relationship @('a_id', 'b_id') 'relationships'
        foreach ($field in @('current_exchange', 'hidden_asymmetry', 'turning_event', 'after_turn_state', 'scene_opportunity')) { [void](Require-ConcreteText $relationship $field 'relationships' 4) }
        foreach ($id in @($relationship.a_id, $relationship.b_id)) { if ($id -notin $characterIds) { Add-Error "关系引用了不存在的角色 id: $id" } }
        if ($relationship.a_id -eq $relationship.b_id) { Add-Error '关系不得把同一角色作为 a_id 和 b_id' }
        $relationshipKeys += (@($relationship.a_id, $relationship.b_id) | Sort-Object) -join '|'
        if ($relationship.a_id -in $protagonistIds -or $relationship.b_id -in $protagonistIds) { $linksProtagonist = $true }
    }
    if (($relationshipKeys | Sort-Object -Unique).Count -ne $relationshipKeys.Count) { Add-Error '同一对角色不得重复声明关系' }
    if (-not $linksProtagonist) { Add-Error '至少一条关系必须关联主角' }
    $genreModule = Require-Object $metadata 'genre_module' '元数据'
    $moduleKinds = @()
    if ($null -ne $genreModule) {
        $primary = Require-Object $genreModule 'primary' 'genre_module'
        if ($null -ne $primary) {
            if ($primary.owns_main_conflict -ne $true) { Add-Error 'genre_module.primary.owns_main_conflict 必须为 true' }
            $primaryKind = Validate-Module $primary 'genre_module.primary' $characterIds $factionIds
            if ($null -ne $primaryKind) { $moduleKinds += $primaryKind }
        }
        $secondary = Require-Array $genreModule 'secondary' 'genre_module' 0 1
        foreach ($module in $secondary) {
            Require-Text $module 'contribution' 'genre_module.secondary' | Out-Null
            $kind = Validate-Module $module 'genre_module.secondary' $characterIds $factionIds (-not $IsCore)
            if ($null -ne $kind) { $moduleKinds += $kind }
        }
        if (($moduleKinds | Sort-Object -Unique).Count -ne $moduleKinds.Count) { Add-Error '主模块与辅模块不得重复' }
    }
    $continuity = Require-Object $metadata 'continuity' '元数据'
    if ($null -ne $continuity) {
        $timeline = Require-Array $continuity 'timeline' 'continuity' 1
        foreach ($item in $timeline) { Require-Texts $item @('time', 'event', 'consequence') 'continuity.timeline' }
        $states = Require-Object $continuity 'character_states' 'continuity'
        if ($null -ne $states) {
            foreach ($id in $characterIds) {
                if (-not (Has-Field $states $id)) { Add-Error "continuity.character_states 缺少角色: $id"; continue }
                Require-Texts $states.$id @('status', 'current_position') "continuity.character_states.$id"
            }
        }
        if ($IsFull) {
            $travel = Require-Array $continuity 'location_travel' 'continuity'
            foreach ($item in $travel) {
                Require-Texts $item @('from_id', 'to_id', 'method', 'duration', 'constraint') 'continuity.location_travel'
                foreach ($id in @($item.from_id, $item.to_id)) { if ($id -notin $locationIds) { Add-Error "移动引用了不存在的地点 id: $id" } }
            }
            $resources = Require-Array $continuity 'scarce_resources' 'continuity'
            foreach ($item in $resources) { Require-Texts $item @('name', 'quantity_or_access', 'controller', 'change_condition') 'continuity.scarce_resources' }
            $facts = Require-Array $continuity 'immutable_facts' 'continuity'
            foreach ($item in $facts) { Require-Texts $item @('fact', 'reason', 'exceptions') 'continuity.immutable_facts' }
            $deadCharacters = @($characters | Where-Object { $_.status -eq 'dead' })
            if ($deadCharacters.Count -gt 0 -and $facts.Count -eq 0) { Add-Error '存在死亡角色时，continuity.immutable_facts 至少需要一条对应事实' }
            foreach ($dead in $deadCharacters) {
                $matched = $false
                foreach ($fact in $facts) {
                    if ("$($fact.fact) $($fact.reason) $($fact.exceptions)" -match [regex]::Escape($dead.id) -or "$($fact.fact) $($fact.reason) $($fact.exceptions)" -match [regex]::Escape($dead.name) -or "$($fact.fact) $($fact.reason) $($fact.exceptions)" -match [regex]::Escape($dead.death_cause)) { $matched = $true; break }
                }
                if (-not $matched) { Add-Error "continuity.immutable_facts 未覆盖死亡角色: $($dead.id)" }
            }
        }
    }
    Require-Fields $constraints @('continuity_guardrails', 'narrative_guardrails', 'lexical_guardrails') '写作约束'
    $continuityGuardrails = Require-Object $constraints 'continuity_guardrails' 'continuity_guardrails'
    if ($null -ne $continuityGuardrails) { [void](Require-TextItems $continuityGuardrails 'hard_facts' 'continuity_guardrails' 1) }
    $narrative = Require-Object $constraints 'narrative_guardrails' '写作约束'
    if ($null -ne $narrative) {
        foreach ($field in @('avoid_moves', 'required_moves')) { [void](Require-TextItems $narrative $field 'narrative_guardrails' 1) }
        $sceneTest = Require-Object $narrative 'scene_test' 'narrative_guardrails'
        if ($null -ne $sceneTest) { foreach ($field in @('desire', 'obstacle', 'action', 'changed_state', 'unresolved_pull')) { [void](Require-ConcreteText $sceneTest $field 'narrative_guardrails.scene_test' 4) } }
        if ($IsFull) {
            [void](Require-ConcreteText $narrative 'reveal_policy' 'narrative_guardrails' 10)
            [void](Require-ConcreteText $narrative 'relationship_policy' 'narrative_guardrails' 10)
        }
    }
    $lexical = Require-Object $constraints 'lexical_guardrails' '写作约束'
    if ($null -ne $lexical) {
        [void](Require-TextItems $lexical 'avoid' 'lexical_guardrails' 1)
        [void](Require-TextItems $lexical 'prefer' 'lexical_guardrails' 1)
        if ($IsFull) {
            $voices = Require-Object $lexical 'character_voice' 'lexical_guardrails'
            if ($null -ne $voices) { foreach ($character in $characters | Where-Object { $_.priority -eq 'P0' }) { [void](Require-ConcreteText $voices $character.id 'lexical_guardrails.character_voice' 6) } }
        }
    }
    Require-Fields $manifest @('package_files', 'genre_modules', 'consumer_read_order', 'open_decisions') 'manifest'
    $manifestFiles = Require-Array $manifest 'package_files' 'manifest' 4
    $manifestFileNames = @()
    foreach ($file in $manifestFiles) {
        if ($file -isnot [string] -or [string]::IsNullOrWhiteSpace($file)) { Add-Error 'manifest.package_files 每项必须是非空文件名'; continue }
        $manifestFileNames += $file
        if (-not (Test-Path -LiteralPath (Join-Path $PackagePath $file) -PathType Leaf)) { Add-Error "manifest.package_files 引用了不存在的文件: $file" }
    }
    if (($manifestFileNames | Sort-Object -Unique).Count -ne $manifestFileNames.Count) { Add-Error 'manifest.package_files 不得重复' }
    foreach ($file in $requiredFiles) { if ($file -notin $manifestFileNames) { Add-Error "manifest.package_files 未声明: $file" } }
    $manifestKinds = Require-TextItems $manifest 'genre_modules' 'manifest' 1
    $normalizedManifestKinds = (@($manifestKinds) | Sort-Object) -join '|'
    $normalizedMetadataKinds = (@($moduleKinds) | Sort-Object) -join '|'
    if ($normalizedManifestKinds -ne $normalizedMetadataKinds) { Add-Error 'manifest.genre_modules 必须与 metadata.genre_module 一致' }
    [void](Require-TextItems $manifest 'open_decisions' 'manifest')
    $orders = Require-Object $manifest 'consumer_read_order' 'manifest'
    if ($null -ne $orders) {
        foreach ($consumer in @('beat_sheet', 'draft', 'revision')) {
            $order = Require-Array $orders $consumer 'manifest.consumer_read_order' 2
            if ($order.Count -ne (@($order | Select-Object -Unique)).Count) { Add-Error "$consumer 的读取顺序不得重复文件" }
            foreach ($item in $order) { if ($item -isnot [string] -or $item -notin $manifestFileNames) { Add-Error "$consumer 的读取顺序引用了未声明文件: $item" } }
            if ($order.Count -ge 2 -and ($order[0] -ne '02_写作约束.json' -or $order[1] -ne '01_设定元数据.json')) { Add-Error "$consumer 的读取顺序必须先写作约束、后设定元数据" }
        }
        $outlineOrder = Require-Array $orders 'outline' 'manifest.consumer_read_order' 2
        if ($outlineOrder.Count -ne (@($outlineOrder | Select-Object -Unique)).Count) { Add-Error 'outline 的读取顺序不得重复文件' }
        foreach ($item in $outlineOrder) { if ($item -isnot [string] -or $item -notin $manifestFileNames) { Add-Error "outline 的读取顺序引用了未声明文件: $item" } }
        if ($outlineOrder.Count -ge 2 -and ($outlineOrder[0] -ne '01_设定元数据.json' -or $outlineOrder[1] -ne '02_写作约束.json')) { Add-Error 'outline 的读取顺序必须先设定元数据、后写作约束' }
    }
}
if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_) }; exit 1 }
Write-Host "设定包校验通过 [$Mode]。"



