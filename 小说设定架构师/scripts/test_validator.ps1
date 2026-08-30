param()

$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path -Parent $PSScriptRoot
$validator = Join-Path $PSScriptRoot 'validate_setting_package.ps1'
$exampleRoot = Join-Path $skillRoot 'references\示例_最小设定包'
$templateRoot = Join-Path $skillRoot 'references\题材模板'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("novel-setting-validator-" + [guid]::NewGuid().ToString('N'))
$passed = 0
$failed = 0

function Save-Json($Object, [string]$Path) {
    $Object | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Invoke-Validation([string]$PackagePath, [string]$Mode) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $validator -PackagePath $PackagePath -Mode $Mode 1>$null 2>$null
    $ErrorActionPreference = $previousPreference
    return $LASTEXITCODE
}

function Assert-Exit([string]$Name, [int]$Actual, [int]$Expected) {
    if ($Actual -eq $Expected) {
        Write-Host "PASS $Name"
        $script:passed++
    } else {
        Write-Host "FAIL $Name (expected=$Expected actual=$Actual)" -ForegroundColor Red
        $script:failed++
    }
}

function Copy-RomanceProbe([string]$Name) {
    $target = Join-Path $testRoot $Name
    Copy-Item -LiteralPath (Join-Path $exampleRoot 'romance') -Destination $target -Recurse
    return $target
}

New-Item -ItemType Directory -Path $testRoot | Out-Null

try {
    foreach ($genre in @('romance', 'progression')) {
        $package = Join-Path $exampleRoot $genre
        Assert-Exit "$genre example core" (Invoke-Validation $package 'core') 0
        Assert-Exit "$genre example full" (Invoke-Validation $package 'full') 0
    }

    foreach ($kind in @('progression', 'urban', 'romance', 'mystery', 'historical', 'science_fiction')) {
        $package = Copy-RomanceProbe "genre-$kind"
        $metadataPath = Join-Path $package '01_设定元数据.json'
        $manifestPath = Join-Path $package 'manifest.json'
        $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $template = Get-Content -LiteralPath (Join-Path $templateRoot "$kind.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        $template | Add-Member -NotePropertyName owns_main_conflict -NotePropertyValue $true
        $metadata.genre_module.primary = $template
        $manifest.genre_modules = @($kind)
        Save-Json $metadata $metadataPath
        Save-Json $manifest $manifestPath
        Assert-Exit "$kind template full" (Invoke-Validation $package 'full') 0
    }

    $package = Copy-RomanceProbe 'core-only'
    $metadataPath = Join-Path $package '01_设定元数据.json'
    $constraintsPath = Join-Path $package '02_写作约束.json'
    $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $constraints = Get-Content -LiteralPath $constraintsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($field in @('escalation_ladder', 'ending_question')) { $metadata.story_engine.PSObject.Properties.Remove($field) }
    $metadata.world.PSObject.Properties.Remove('factions')
    foreach ($field in @('location_travel', 'scarce_resources', 'immutable_facts')) { $metadata.continuity.PSObject.Properties.Remove($field) }
    foreach ($field in @('reveal_policy', 'relationship_policy')) { $constraints.narrative_guardrails.PSObject.Properties.Remove($field) }
    $constraints.lexical_guardrails.PSObject.Properties.Remove('character_voice')
    Save-Json $metadata $metadataPath
    Save-Json $constraints $constraintsPath
    Assert-Exit 'core-only package core' (Invoke-Validation $package 'core') 0
    Assert-Exit 'core-only package full' (Invoke-Validation $package 'full') 1

    $package = Copy-RomanceProbe 'secondary-shell'
    $metadataPath = Join-Path $package '01_设定元数据.json'
    $manifestPath = Join-Path $package 'manifest.json'
    $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $metadata.genre_module.secondary = @([PSCustomObject]@{ kind = 'urban'; contribution = '通过职业资源压力改变关系选择' })
    $manifest.genre_modules = @('romance', 'urban')
    Save-Json $metadata $metadataPath
    Save-Json $manifest $manifestPath
    Assert-Exit 'secondary shell core' (Invoke-Validation $package 'core') 0
    Assert-Exit 'secondary shell full' (Invoke-Validation $package 'full') 1

    $package = Copy-RomanceProbe 'self-relationship'
    $metadataPath = Join-Path $package '01_设定元数据.json'
    $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $metadata.relationships[0].b_id = $metadata.relationships[0].a_id
    Save-Json $metadata $metadataPath
    Assert-Exit 'self relationship rejected' (Invoke-Validation $package 'full') 1

    $package = Copy-RomanceProbe 'empty-hard-facts'
    $constraintsPath = Join-Path $package '02_写作约束.json'
    $constraints = Get-Content -LiteralPath $constraintsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $constraints.continuity_guardrails.hard_facts = @()
    Save-Json $constraints $constraintsPath
    Assert-Exit 'empty hard facts rejected' (Invoke-Validation $package 'full') 1

    $package = Copy-RomanceProbe 'placeholder'
    $metadataPath = Join-Path $package '01_设定元数据.json'
    $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $metadata.novel.premise = '待填写'
    Save-Json $metadata $metadataPath
    Assert-Exit 'placeholder rejected' (Invoke-Validation $package 'full') 1

    $package = Copy-RomanceProbe 'empty-brief'
    Set-Content -LiteralPath (Join-Path $package '00_创作简报.md') -Value '' -Encoding UTF8
    Assert-Exit 'empty brief rejected' (Invoke-Validation $package 'full') 1
}
finally {
    $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $resolvedTest = [System.IO.Path]::GetFullPath($testRoot)
    if ($resolvedTest.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTest)) {
        Remove-Item -LiteralPath $resolvedTest -Recurse -Force
    }
}

Write-Host "Result: passed=$passed failed=$failed"
if ($failed -gt 0) { exit 1 }
