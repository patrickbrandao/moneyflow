# 003 — Entidades, PIX e dados bancários

Entidades são **globais** (cadastradas uma vez, usadas por todas as caixas).

- Pessoa (CPF, dados pessoais) ou Empresa (CNPJ numérico **e alfanumérico**, razão social, nome fantasia).
- Validação dos dígitos de CPF e CNPJ; autopreenchimento de CNPJ (BrasilAPI/ReceitaWS) e de CEP (ViaCEP).
- Contatos múltiplos (telefones, emails), endereço, anotações, anexos.
- Dados bancários (banco, agência, conta, tipo).
- Chaves PIX: CPF, CNPJ, email, telefone e aleatória (EVP), com validação de formato; várias por entidade, uma principal (mostrada no título a pagar); banco/apelido opcional; botão copiar.
- Vínculos entre entidades (sócio de, responsável por, cônjuge…).
- Uma entidade pode ser titular de caixas (ver [004](004-caixas-e-contas.md)).
