--colonies with population but no governor
with CTE_ColoniesToIgnore as
(
	select 'Panagiatopoulos Group' as PopName
	--union all select 'anotherone' 
)

select
	p.popname, c.*
FROM
	vw_pop as p
left join FCT_Commander as c on c.CommandID = p.PopulationID and c.CommandType = 3
left join CTE_ColoniesToIgnore as x on x.PopName = p.PopName
where 
	c.CommandID is null
AND
	p.Population > 0
AND
	x.PopName is null