@echo off
setlocal EnableExtensions
title Promobank x WhatsApp - Bot
cd /d "%~dp0"

echo ============================================================
echo    PROMOBANK x WHATSAPP  -  INICIAR BOT
echo ============================================================
echo    Pasta : %CD%
echo.

rem ---------- 1) Node.js e npm disponiveis? ----------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado no PATH.
    echo        Instale o Node.js LTS ^(https://nodejs.org^) e tente de novo.
    echo.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERRO] npm nao encontrado no PATH.
    echo        Reinstale o Node.js LTS marcando a opcao "Add to PATH".
    echo.
    pause
    exit /b 1
)

rem ---------- 2) Verificacao de instancia duplicada ----------
rem   Codigos de saida: 0 = livre | 2 = ja rodando | 3 = nao foi possivel verificar
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $ok=$false; $run=$false; try { $b = @(Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' -ErrorAction Stop | Where-Object { $_.CommandLine -match 'src[/\\]main\.js' }); $ok=$true; if ($b.Count -gt 0) { $run=$true; foreach ($p in $b) { Write-Host ('    - PID ' + $p.ProcessId + '   iniciado em ' + $p.CreationDate) } } } catch { }; if (-not $ok) { $c = @(Get-NetTCPConnection -LocalPort 9223 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Established' }); if ($c.Count -gt 0) { $ok=$true; $run=$true; Write-Host ('    - Chrome do Promobank em uso pelo PID ' + ($c.OwningProcess -join ', ')) } }; if ($run) { exit 2 }; if (-not $ok) { exit 3 }; exit 0"

set "CHK=%ERRORLEVEL%"

if "%CHK%"=="2" (
    echo.
    echo [BLOQUEADO] O bot JA ESTA EM EXECUCAO.
    echo.
    echo   Duas instancias usam a MESMA sessao do WhatsApp e entram em
    echo   loop de reconexao ^(erro 440^), deixando o bot inutil.
    echo.
    echo   Feche a janela do bot que ja esta aberta e rode este atalho
    echo   novamente.
    echo.
    pause
    exit /b 1
)

if "%CHK%"=="3" (
    echo.
    echo [ATENCAO] Nao foi possivel verificar automaticamente se o bot
    echo           ja esta rodando neste computador.
    echo.
    echo   Se o bot ja estiver aberto em OUTRA janela, feche-a agora.
    echo   Duas instancias causam conflito de sessao no WhatsApp ^(440^).
    echo.
    pause
)

echo [OK] Nenhuma outra instancia detectada.
echo.

rem ---------- 3) Dependencias ----------
if not exist "node_modules\@whiskeysockets\baileys" (
    echo [INFO] Dependencias ausentes. Executando "npm install"...
    echo.
    call npm.cmd install
    if errorlevel 1 (
        echo.
        echo [ERRO] Falha ao instalar as dependencias.
        pause
        exit /b 1
    )
    echo.
)

rem ---------- 4) Arquivo de configuracao ----------
if not exist "%LOCALAPPDATA%\PromobankWhatsAppBot\.env" (
    echo [INFO] Configuracao ausente. Criando a partir de .env.example...
    if not exist "%LOCALAPPDATA%\PromobankWhatsAppBot" mkdir "%LOCALAPPDATA%\PromobankWhatsAppBot"
    copy /y ".env.example" "%LOCALAPPDATA%\PromobankWhatsAppBot\.env" >nul
    echo [OK] Configuracao criada: %LOCALAPPDATA%\PromobankWhatsAppBot\.env
    echo.
)

echo ------------------------------------------------------------
echo  Como usar:
echo    - 1a vez  : leia o QR code no WhatsApp ^> Aparelhos conectados.
echo    - Chrome  : abre sozinho, faca o login no Promobank nele.
echo    - Encerrar: feche esta janela ou aperte Ctrl+C.
echo ------------------------------------------------------------
echo.

call npm.cmd start

echo.
echo ============================================================
echo    Bot encerrado.
echo ============================================================
pause