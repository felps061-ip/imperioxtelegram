# Promobank x WhatsApp

Aplicativo local para receber CPFs no grupo **TESTE PROMOBANK**, consultar o módulo INSS no Promobank e entregar o PDF no WhatsApp privado de quem fez a solicitação.

## Funcionamento

1. A TI inicia o aplicativo pela manhã.
2. Uma janela dedicada do Chrome é aberta para o Promobank.
3. A TI resolve qualquer captcha do Cloudflare e faz o login manual nessa janela.
4. Na primeira execução, conecte o WhatsApp lendo o QR code exibido no terminal.
5. Um participante envia somente o CPF no grupo `TESTE PROMOBANK`.
6. O aplicativo completa zeros à esquerda até 11 dígitos, valida o CPF e executa uma consulta por vez.
7. Confirmações, erros e o PDF são enviados no privado do solicitante.

Mensagens de outros grupos, conversas privadas e textos que não sejam apenas um CPF são ignorados.

## Requisitos

- Windows com Google Chrome instalado.
- Node.js 22 ou superior.
- O número conectado precisa participar do grupo `TESTE PROMOBANK`.
- O computador deve permanecer ligado e com o aplicativo em execução.

## Instalação

No PowerShell, dentro desta pasta:

```powershell
npm.cmd install
$configDir = Join-Path $env:LOCALAPPDATA 'PromobankWhatsAppBot'
New-Item -ItemType Directory -Path $configDir -Force
Copy-Item -LiteralPath '.env.example' -Destination (Join-Path $configDir '.env')
npm.cmd start
```

O arquivo de configuração e as sessões ficam em `%LOCALAPPDATA%\PromobankWhatsAppBot`, fora do OneDrive.

## Primeira conexão do WhatsApp

Ao executar `npm.cmd start`, o terminal exibirá um QR code. No celular que possui o número de teste:

1. Abra o WhatsApp.
2. Acesse **Aparelhos conectados**.
3. Selecione **Conectar aparelho**.
4. Leia o QR code do terminal.

Nas próximas execuções, a sessão será reutilizada enquanto o WhatsApp não a desconectar. Antes de aceitar qualquer CPF, o aplicativo consulta os grupos vinculados e exige encontrar exatamente um grupo chamado `TESTE PROMOBANK`.

## Login diário no Promobank

O Chrome exclusivo do Promobank abre automaticamente. Resolva qualquer captcha do Cloudflare e faça o login nessa janela. O aplicativo se conecta a esse Chrome por uma porta local dedicada e reutiliza a sessão enquanto ela estiver válida. Não abra esse mesmo perfil em outro processo.

As credenciais `PROMOBANK_COMPANY`, `PROMOBANK_USERNAME` e `PROMOBANK_PASSWORD` podem permanecer vazias. Com este modo manual, o aplicativo não digita login, senha ou resolve captcha.

O PDF é baixado em `%LOCALAPPDATA%\PromobankWhatsAppBot\pdf-cache` e enviado como documento no privado. Depois do upload, o arquivo é apagado automaticamente para evitar retenção desnecessária.

## Formatos de CPF

São aceitos no grupo:

```text
529.982.247-25
52998224725
998224725
```

O terceiro exemplo é transformado em `00998224725` antes da validação. Se os dígitos verificadores não forem válidos, o solicitante recebe o aviso no privado.

## Testes

```powershell
npm.cmd test
```

Os testes automatizados não acessam o WhatsApp nem o Promobank. O primeiro teste real deve usar um CPF autorizado e ser acompanhado pela TI.

## Limitações

- A conexão usa o protocolo de aparelhos vinculados e não a API oficial; mudanças do WhatsApp ou desconexões podem exigir atualização ou nova leitura do QR code.
- A fila fica em memória. Pedidos pendentes precisam ser reenviados se o aplicativo for encerrado.
- Alterações na interface do Promobank podem exigir atualização dos seletores.
- CAPTCHA, conflito de sessão ou avisos adicionais do Promobank exigem intervenção da TI.
