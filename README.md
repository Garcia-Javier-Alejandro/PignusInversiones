# Inversiones

Repositorio de trabajo para investigación y gestión de inversiones personales.

## Objetivos

### Investigación de mercado
Análisis y seguimiento del mercado de inversiones con el fin de definir estrategias de inversión: instrumentos a incorporar, momentos de entrada/salida, diversificación de cartera, etc.

### Resúmenes de cuenta de inversión
Generación de resúmenes periódicos del estado de las cuentas de inversión, con métricas de rendimiento, composición de cartera y evolución patrimonial.

## Cuentas

### Inviu (cuenta 184318)
Cuenta de referencia. Los resúmenes históricos ubicados en la carpeta `Inviu/` sirven como base, formato y contexto para la generación de nuevos resúmenes.

### Pignus
Cuenta administrada en la plataforma **IOL (InvertirOnline)**, cuyos titulares son **Graciela y Fiorella**. Los resúmenes de esta cuenta se generan tomando como modelo el formato establecido por los resúmenes de Inviu.

#### Workflow mensual
1. Subir a `Pignus/` el **Detalle de Operaciones** y el **Estado de Cuenta** del período, exportados desde IOL.
2. Solicitar la generación del resumen mensual.
3. El resumen incluye análisis de la cartera y una lista de **accionables** para trabajar durante el mes.

## Estructura

```
Inversiones/
├── Inviu/                          # Resúmenes históricos de la cuenta Inviu (formato de referencia)
├── Pignus/                         # Insumos mensuales: Detalle de Operaciones + Estado de Cuenta (IOL)
└── Resumen de Cuenta Pignus *.pdf  # Resúmenes generados de la cuenta Pignus
```
