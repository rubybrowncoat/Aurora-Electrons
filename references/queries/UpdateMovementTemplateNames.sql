select 
	TemplateName 
	--,replace(replace(replace(TemplateName,'>','-'),'--LP','-'),'--2','-2')
	from FCT_OrderTemplate as t 
	--where TemplateName like '%>%'
order by TemplateName

update FCT_OrderTemplate
set TemplateName = replace(replace(replace(TemplateName,'>','-'),'--LP','-'),'--2','-2')
where TemplateName like '%>%'