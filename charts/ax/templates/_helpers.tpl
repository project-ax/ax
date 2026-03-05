{{/*
Expand the name of the chart.
*/}}
{{- define "ax.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "ax.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label values.
*/}}
{{- define "ax.labels" -}}
helm.sh/chart: {{ include "ax.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: ax
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end }}

{{/*
Chart name and version for chart label.
*/}}
{{- define "ax.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Component labels — call with (dict "component" "host" "context" $)
*/}}
{{- define "ax.componentLabels" -}}
{{ include "ax.labels" .context }}
app.kubernetes.io/name: {{ include "ax.fullname" .context }}-{{ .component }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Selector labels for a component — call with (dict "component" "host" "context" $)
*/}}
{{- define "ax.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ax.fullname" .context }}-{{ .component }}
{{- end }}

{{/*
Container image string for a component.
Call with (dict "image" .Values.host.image "global" .Values.global "context" $)
*/}}
{{- define "ax.image" -}}
{{- $registry := .image.registry | default .global.imageRegistry | default "" -}}
{{- $repo := .image.repository -}}
{{- $tag := .image.tag | default .context.Chart.AppVersion -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repo $tag -}}
{{- else -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end }}

{{/*
NATS URL — uses subchart service if enabled, otherwise external URL.
*/}}
{{- define "ax.natsUrl" -}}
{{- if .Values.nats.enabled -}}
nats://{{ include "ax.fullname" . }}-nats.{{ .Release.Namespace }}.svc.cluster.local:4222
{{- else -}}
{{ .Values.nats.externalUrl | default "nats://nats:4222" }}
{{- end -}}
{{- end }}

{{/*
Database secret reference.
*/}}
{{- define "ax.databaseSecretRef" -}}
{{- if .Values.postgresql.external.enabled -}}
{{ .Values.postgresql.external.existingSecret | default "ax-db-credentials" }}
{{- else -}}
{{ include "ax.fullname" . }}-postgresql
{{- end -}}
{{- end }}

{{/*
Namespace — use .Values.namespace.name or Release.Namespace.
*/}}
{{- define "ax.namespace" -}}
{{- .Values.namespace.name | default .Release.Namespace -}}
{{- end }}

{{/*
AX plane label for network policy selectors.
*/}}
{{- define "ax.planeLabel" -}}
ax.io/plane: {{ . }}
{{- end }}
